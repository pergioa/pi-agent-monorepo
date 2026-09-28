import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const STDERR_LIMIT = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_END_SETTLE_MS = 100;
const DEFAULT_FINISH_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

export type HeadlessLifecycleState =
  | "reserved"
  | "launching"
  | "running"
  | "stopping"
  | "finished"
  | "failed";

export interface HeadlessWaitResult {
  exitCode: number;
  errorMessage?: string;
  stderr?: string;
}

export interface HeadlessRuntimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface SpawnHeadlessRuntimeSpec {
  runId: string;
  sessionFile: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  initialPrompts: string[];
  onEvent?: (event: HeadlessRuntimeEvent) => void;
  shouldStopAfterAgentEnd?: () => boolean;
  /** Abort startup and terminate the owned process. */
  signal?: AbortSignal;
  /** Append `--mode rpc` unless the args already contain a mode. Defaults to true. */
  rpcMode?: boolean;
  /** Time allowed for all initial commands to be accepted. Defaults to 30 seconds. */
  startupTimeoutMs?: number;
  /** Delay before treating agent_end as terminal so adjacent retry/queue events arrive. */
  agentEndSettleMs?: number;
  /** Time allowed for an stdin close before `finish()` sends SIGTERM. */
  finishGraceMs?: number;
  /** Time allowed after SIGTERM before SIGKILL. */
  terminationGraceMs?: number;
}

export interface HeadlessRuntime {
  readonly kind: "headless";
  readonly runId: string;
  readonly canonicalSessionFile: string;
  readonly pid?: number;
  state: HeadlessLifecycleState;
  isAlive(): boolean;
  /** Prompt an idle agent or steer a streaming agent, then await acceptance. */
  send(message: string): Promise<void>;
  /** Wait for process close. Aborting terminates the child before resolving. */
  wait(signal?: AbortSignal, onTick?: () => void): Promise<HeadlessWaitResult>;
  /** Close stdin, then escalate through SIGTERM and SIGKILL if necessary. */
  finish(): Promise<HeadlessWaitResult>;
  /** Send SIGTERM immediately, then SIGKILL if necessary. */
  stop(): Promise<HeadlessWaitResult>;
}

export class HeadlessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeadlessError";
  }
}

/**
 * Reuse the running Pi process's JavaScript entrypoint when possible. Test
 * runners and source loaders commonly put a TypeScript file in argv[1], which
 * is not a portable child entrypoint, so those correctly fall back to `pi`.
 */
export function resolvePiCommand(): { command: string; baseArgs: string[] } {
  const entrypoint = process.argv[1];
  if (entrypoint && [".js", ".mjs", ".cjs"].includes(extname(entrypoint).toLowerCase())) {
    try {
      if (statSync(entrypoint).isFile()) {
        return { command: process.execPath, baseArgs: [entrypoint] };
      }
    } catch {
      // Fall through to PATH resolution.
    }
  }
  return { command: "pi", baseArgs: [] };
}

const sessionOwners = new Map<string, string>();
const runOwners = new Map<string, string>();

function canonicalizeSessionFile(sessionFile: string): string {
  const absolute = resolve(sessionFile);
  let existingAncestor = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) return absolute;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

function claimOwnership(sessionFile: string, runId: string): void {
  const sessionOwner = sessionOwners.get(sessionFile);
  if (sessionOwner !== undefined) {
    throw new HeadlessError(
      `Session file ${sessionFile} is already owned by headless run '${sessionOwner}'`,
    );
  }
  const ownedSession = runOwners.get(runId);
  if (ownedSession !== undefined) {
    throw new HeadlessError(
      `Headless run '${runId}' already owns session file ${ownedSession}`,
    );
  }
  sessionOwners.set(sessionFile, runId);
  runOwners.set(runId, sessionFile);
}

function releaseOwnership(sessionFile: string, runId: string): void {
  if (sessionOwners.get(sessionFile) === runId) sessionOwners.delete(sessionFile);
  if (runOwners.get(runId) === sessionFile) runOwners.delete(runId);
}

function rpcArgs(args: readonly string[], appendMode: boolean): string[] {
  if (!appendMode || args.some((arg) => arg === "--mode" || arg.startsWith("--mode="))) {
    return [...args];
  }
  return [...args, "--mode", "rpc"];
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? value! : fallback;
}

interface StructuredOutcome {
  error?: string;
}

function assistantOutcome(value: unknown): StructuredOutcome | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  if (message.role !== "assistant") return undefined;
  if (message.stopReason !== "error") return {};
  return {
    error:
      typeof message.errorMessage === "string" && message.errorMessage.trim()
        ? message.errorMessage.trim()
        : "Assistant stopped with an error without providing an errorMessage",
  };
}

function structuredOutcome(record: HeadlessRuntimeEvent): StructuredOutcome | undefined {
  if (
    record.type === "compaction_end" &&
    typeof record.errorMessage === "string" &&
    record.errorMessage.trim()
  ) {
    return { error: record.errorMessage.trim() };
  }
  if (record.type === "auto_retry_end" && record.success === false) {
    return {
      error:
        typeof record.finalError === "string" && record.finalError.trim()
          ? record.finalError.trim()
          : "Provider auto-retry failed without an error message",
    };
  }
  if (record.type === "auto_retry_end" && record.success === true) return {};

  if (record.type === "message_end" || record.type === "turn_end") {
    return assistantOutcome(record.message);
  }
  if (record.type === "agent_end" && Array.isArray(record.messages)) {
    for (let index = record.messages.length - 1; index >= 0; index -= 1) {
      const outcome = assistantOutcome(record.messages[index]);
      if (outcome) return outcome;
    }
  }
  return undefined;
}

interface PendingRpc {
  command: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

class HeadlessRuntimeImpl implements HeadlessRuntime {
  readonly kind = "headless" as const;
  readonly runId: string;
  readonly canonicalSessionFile: string;
  pid?: number;
  state: HeadlessLifecycleState = "reserved";

  private readonly spec: SpawnHeadlessRuntimeSpec;
  private child?: ChildProcessWithoutNullStreams;
  private claimed = false;
  private settled = false;
  private stopping = false;
  private spawnError?: Error;
  private protocolError?: string;
  private latestStructuredError?: string;
  private sawValidRecord = false;
  private queuedMessages = 0;
  private retryInProgress = false;
  private pendingAgentEnd = false;
  private sequence = 0;
  private readonly pendingRpc = new Map<string, PendingRpc>();
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stdoutEnded = false;
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private readonly agentEndTimers = new Set<ReturnType<typeof setTimeout>>();
  private sigtermSent = false;
  private readonly tickListeners = new Set<() => void>();
  private readonly closePromise: Promise<HeadlessWaitResult>;
  private resolveClose!: (result: HeadlessWaitResult) => void;

  constructor(spec: SpawnHeadlessRuntimeSpec) {
    this.spec = spec;
    this.runId = spec.runId;
    this.canonicalSessionFile = canonicalizeSessionFile(spec.sessionFile);
    this.closePromise = new Promise((resolveClose) => {
      this.resolveClose = resolveClose;
    });
  }

  reserve(): void {
    claimOwnership(this.canonicalSessionFile, this.runId);
    this.claimed = true;
  }

  launch(): void {
    this.state = "launching";
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(this.spec.env)) {
      if (value !== undefined) env[key] = value;
    }

    try {
      const child = spawn(
        this.spec.command,
        rpcArgs(this.spec.args, this.spec.rpcMode ?? true),
        {
          cwd: this.spec.cwd,
          env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      this.child = child;
      this.pid = child.pid;

      child.once("error", (error) => {
        this.spawnError = error;
      });
      child.once("close", (code, signal) => this.settle(code, signal));
      child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(this.decoder.write(chunk)));
      child.stdout.once("end", () => this.endStdout());
      child.stderr.on("data", (chunk: Buffer) => this.captureStderr(chunk));
      child.stdin.on("error", (error) => {
        this.rejectPending(new HeadlessError(`Headless RPC stdin failed: ${error.message}`, { cause: error }));
      });
    } catch (error) {
      this.spawnError = asError(error);
      this.settle(1, null);
    }
  }

  async acceptInitialPrompts(): Promise<void> {
    const timeoutMs = positiveDelay(this.spec.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(
          new HeadlessError(
            `Headless RPC startup timed out after ${timeoutMs}ms waiting for initial command acceptance`,
          ),
        );
      }, timeoutMs);
      timeout.unref?.();
    });

    try {
      await Promise.race([
        (async () => {
          for (let index = 0; index < this.spec.initialPrompts.length; index += 1) {
            await this.sendRpc(index === 0 ? "prompt" : "follow_up", this.spec.initialPrompts[index]);
          }
        })(),
        timeoutPromise,
      ]);
      if (this.settled) {
        throw new HeadlessError("Headless RPC process closed during startup");
      }
      if (this.stopping) {
        throw new HeadlessError("Headless RPC startup was cancelled");
      }
      this.state = "running";
    } finally {
      clearTimeout(timeout);
    }
  }

  isAlive(): boolean {
    return !this.settled && this.child !== undefined;
  }

  async send(message: string): Promise<void> {
    if (this.state !== "running" || this.settled || this.stopping) {
      throw new HeadlessError(`Cannot steer headless run '${this.runId}' while it is ${this.state}`);
    }
    // RPC prompt executes extension slash commands immediately, even while the
    // agent is streaming. A leading newline preserves the instruction for the
    // model while preventing a live message from bypassing steering semantics.
    const safeMessage = message.startsWith("/") ? `\n${message}` : message;
    await this.sendRpc("prompt", safeMessage, { streamingBehavior: "steer" });
  }

  wait(signal?: AbortSignal, onTick?: () => void): Promise<HeadlessWaitResult> {
    if (onTick) this.tickListeners.add(onTick);
    const abort = () => {
      void this.stop();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    return this.closePromise.finally(() => {
      signal?.removeEventListener("abort", abort);
      if (onTick) this.tickListeners.delete(onTick);
    });
  }

  finish(): Promise<HeadlessWaitResult> {
    if (!this.settled && !this.stopping) {
      this.stopping = true;
      this.state = "stopping";
      this.child?.stdin.end();
      const delay = positiveDelay(this.spec.finishGraceMs, DEFAULT_FINISH_GRACE_MS);
      this.finishTimer = setTimeout(() => this.sendSigterm(), delay);
      this.finishTimer.unref?.();
    }
    return this.closePromise;
  }

  stop(): Promise<HeadlessWaitResult> {
    if (!this.settled) {
      if (!this.stopping) {
        this.stopping = true;
        this.state = "stopping";
      }
      if (!this.sigtermSent) this.sendSigterm();
    }
    return this.closePromise;
  }

  startupFailure(error: unknown, result: HeadlessWaitResult): HeadlessError {
    const original = asError(error);
    const message = this.spawnError
      ? `Failed to spawn headless run '${this.runId}': ${this.spawnError.message}`
      : this.latestStructuredError ?? this.protocolError ?? original.message;
    const withStderr = result.stderr ? `${message}\nstderr: ${result.stderr}` : message;
    return new HeadlessError(withStderr, { cause: original });
  }

  private sendRpc(
    command: "prompt" | "follow_up",
    message: string,
    options?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void> {
    return new Promise((resolveRpc, rejectRpc) => {
      if (!this.child || this.settled || this.stopping) {
        rejectRpc(new HeadlessError(`Cannot send RPC '${command}': child process is not running`));
        return;
      }

      const id = `${this.runId}:${++this.sequence}`;
      this.pendingRpc.set(id, { command, resolve: resolveRpc, reject: rejectRpc });
      const line = `${JSON.stringify({ id, type: command, message, ...options })}\n`;
      this.child.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        const pending = this.pendingRpc.get(id);
        if (!pending) return;
        this.pendingRpc.delete(id);
        pending.reject(
          new HeadlessError(`Failed to write RPC '${command}': ${error.message}`, { cause: error }),
        );
      });
    });
  }

  private consumeStdout(text: string): void {
    this.stdoutBuffer += text;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private endStdout(): void {
    if (this.stdoutEnded) return;
    this.stdoutEnded = true;
    this.consumeStdout(this.decoder.end());
    if (this.stdoutBuffer.length > 0) {
      const finalLine = this.stdoutBuffer;
      this.stdoutBuffer = "";
      this.handleLine(finalLine.endsWith("\r") ? finalLine.slice(0, -1) : finalLine);
    }
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (!this.sawValidRecord && !this.protocolError) {
        this.protocolError = `Malformed RPC JSON: ${line.slice(0, 200)}`;
      }
      return;
    }
    if (value === null || Array.isArray(value) || typeof value !== "object") return;
    const record = value as HeadlessRuntimeEvent;
    if (typeof record.type !== "string") return;

    this.sawValidRecord = true;
    if (record.type === "response") this.acceptResponse(record);
    else this.acceptEvent(record);
    this.notifyTick();
  }

  private acceptResponse(response: HeadlessRuntimeEvent): void {
    if (typeof response.id !== "string") return;
    const pending = this.pendingRpc.get(response.id);
    if (!pending) return;
    this.pendingRpc.delete(response.id);
    if (response.success === true) {
      pending.resolve();
      return;
    }
    const detail = typeof response.error === "string" ? `: ${response.error}` : "";
    pending.reject(new HeadlessError(`RPC '${pending.command}' was rejected${detail}`));
  }

  private acceptEvent(event: HeadlessRuntimeEvent): void {
    const outcome = structuredOutcome(event);
    if (outcome) this.latestStructuredError = outcome.error;

    if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering.length : 0;
      const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
      this.queuedMessages = steering + followUp;
    }
    if (event.type === "agent_start") {
      this.pendingAgentEnd = false;
      this.cancelAgentEndTimers();
    }
    if (event.type === "auto_retry_start" || event.type === "compaction_start") {
      this.cancelAgentEndTimers();
    }
    if (event.type === "auto_retry_start") this.retryInProgress = true;
    if (event.type === "auto_retry_end") this.retryInProgress = false;

    try {
      this.spec.onEvent?.(event);
    } catch {
      // A consumer callback must not corrupt the RPC transport.
    }

    if (event.type === "agent_end") {
      this.pendingAgentEnd = true;
      this.scheduleAgentEndCheck();
    } else if (
      this.pendingAgentEnd &&
      ((event.type === "auto_retry_end" && event.success === false) ||
        (event.type === "compaction_end" && event.willRetry !== true))
    ) {
      this.scheduleAgentEndCheck();
    }
  }

  private captureStderr(chunk: Buffer): void {
    if (this.stderrBytes >= STDERR_LIMIT) return;
    const retained = Buffer.from(chunk.subarray(0, STDERR_LIMIT - this.stderrBytes));
    this.stderrChunks.push(retained);
    this.stderrBytes += retained.byteLength;
  }

  private cancelAgentEndTimers(): void {
    for (const timer of this.agentEndTimers) clearTimeout(timer);
    this.agentEndTimers.clear();
  }

  private scheduleAgentEndCheck(): void {
    this.cancelAgentEndTimers();
    const delay = positiveDelay(this.spec.agentEndSettleMs, DEFAULT_AGENT_END_SETTLE_MS);
    const timer = setTimeout(() => {
      this.agentEndTimers.delete(timer);
      if (
        this.settled ||
        this.stopping ||
        !this.pendingAgentEnd ||
        this.queuedMessages !== 0 ||
        this.retryInProgress
      ) {
        return;
      }
      this.pendingAgentEnd = false;
      let shouldStop = false;
      try {
        shouldStop = this.spec.shouldStopAfterAgentEnd?.() ?? false;
      } catch {
        return;
      }
      if (shouldStop) void this.finish();
    }, delay);
    timer.unref?.();
    this.agentEndTimers.add(timer);
  }

  private sendSigterm(): void {
    clearTimeout(this.finishTimer);
    this.finishTimer = undefined;
    if (this.settled || this.sigtermSent) return;
    this.sigtermSent = true;
    this.child?.kill("SIGTERM");
    const delay = positiveDelay(
      this.spec.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
    );
    this.killTimer = setTimeout(() => {
      if (!this.settled) this.child?.kill("SIGKILL");
    }, delay);
    this.killTimer.unref?.();
  }

  private settle(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    this.endStdout();
    clearTimeout(this.finishTimer);
    clearTimeout(this.killTimer);
    this.cancelAgentEndTimers();

    const exitCode = code ?? (signal ? 1 : 0);
    let errorMessage = this.latestStructuredError;
    if (!errorMessage && this.spawnError) {
      errorMessage = `Failed to spawn headless run '${this.runId}': ${this.spawnError.message}`;
    }
    if (!errorMessage && !this.sawValidRecord) {
      errorMessage =
        this.protocolError ?? "Headless process closed before producing a valid RPC record";
    }
    if (!errorMessage && code !== null && code !== 0) {
      errorMessage = `Headless process exited with code ${code}`;
    }
    if (!errorMessage && signal) {
      errorMessage = `Headless process was terminated by ${signal}`;
    }

    const stderr = Buffer.concat(this.stderrChunks).toString("utf8");
    const result: HeadlessWaitResult = { exitCode };
    if (errorMessage) result.errorMessage = errorMessage;
    if (stderr) result.stderr = stderr;

    const pendingError = new HeadlessError(
      errorMessage ?? `Headless process closed with code ${exitCode}`,
    );
    this.rejectPending(pendingError);
    this.state = errorMessage ? "failed" : "finished";
    if (this.claimed) {
      releaseOwnership(this.canonicalSessionFile, this.runId);
      this.claimed = false;
    }
    this.notifyTick();
    this.resolveClose(result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRpc.values()) pending.reject(error);
    this.pendingRpc.clear();
  }

  private notifyTick(): void {
    for (const listener of this.tickListeners) {
      try {
        listener();
      } catch {
        // Progress callbacks are observational only.
      }
    }
  }
}

/** Spawn Pi directly and resolve only after every initial RPC command succeeds. */
export async function spawnHeadlessRuntime(
  spec: SpawnHeadlessRuntimeSpec,
): Promise<HeadlessRuntime> {
  if (!spec.runId.trim()) throw new HeadlessError("A non-empty runId is required");
  if (!spec.command.trim()) throw new HeadlessError("A non-empty command is required");
  if (spec.initialPrompts.length === 0) {
    throw new HeadlessError("At least one initial prompt is required for RPC startup");
  }

  const runtime = new HeadlessRuntimeImpl(spec);
  runtime.reserve();
  runtime.launch();
  const abort = () => { void runtime.stop(); };
  if (spec.signal?.aborted) abort();
  else spec.signal?.addEventListener("abort", abort, { once: true });
  try {
    await runtime.acceptInitialPrompts();
    return runtime;
  } catch (error) {
    const result = await runtime.stop();
    throw runtime.startupFailure(error, result);
  } finally {
    spec.signal?.removeEventListener("abort", abort);
  }
}
