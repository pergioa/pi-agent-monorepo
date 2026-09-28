import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  HeadlessError,
  resolvePiCommand,
  spawnHeadlessRuntime,
  type HeadlessRuntime,
  type HeadlessRuntimeEvent,
  type SpawnHeadlessRuntimeSpec,
} from "../../pi-extension/subagents/headless.ts";

const fixture = join(process.cwd(), "test", "integration", "fixtures", "fake-pi-rpc.mjs");

describe("headless RPC runtime", { timeout: 20_000 }, () => {
  let temporaryDirectory = "";
  const runtimes = new Set<HeadlessRuntime>();

  before(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-headless-runtime-"));
  });

  after(async () => {
    await Promise.all([...runtimes].map((runtime) => runtime.stop()));
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function spec(
    runId: string,
    overrides: Partial<SpawnHeadlessRuntimeSpec> = {},
  ): SpawnHeadlessRuntimeSpec {
    return {
      runId,
      sessionFile: join(temporaryDirectory, `${runId}.jsonl`),
      command: process.execPath,
      args: [fixture],
      cwd: temporaryDirectory,
      env: {},
      initialPrompts: ["do the work"],
      startupTimeoutMs: 2_000,
      agentEndSettleMs: 5,
      finishGraceMs: 50,
      terminationGraceMs: 50,
      ...overrides,
    };
  }

  async function start(
    runId: string,
    overrides: Partial<SpawnHeadlessRuntimeSpec> = {},
  ): Promise<HeadlessRuntime> {
    const runtime = await spawnHeadlessRuntime(spec(runId, overrides));
    runtimes.add(runtime);
    return runtime;
  }

  function nextEventTurn(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10));
  }

  it("resolves a real JavaScript argv entrypoint or falls back to pi", () => {
    const result = resolvePiCommand();
    assert.ok(result.command.length > 0);
    assert.ok(Array.isArray(result.baseArgs));
    const extension = extname(process.argv[1] ?? "").toLowerCase();
    if (![".js", ".mjs", ".cjs"].includes(extension)) {
      assert.deepEqual(result, { command: "pi", baseArgs: [] });
    }

    const originalEntrypoint = process.argv[1];
    try {
      process.argv[1] = fixture;
      assert.deepEqual(resolvePiCommand(), {
        command: process.execPath,
        baseArgs: [fixture],
      });
    } finally {
      process.argv[1] = originalEntrypoint;
    }
  });

  it("needs no tmux environment and passes explicit cwd and RPC args", async () => {
    let environment: HeadlessRuntimeEvent | undefined;
    let sawEnvironment!: () => void;
    const environmentDelivered = new Promise<void>((resolve) => {
      sawEnvironment = resolve;
    });
    const runtime = await start("environment", {
      env: { TMUX: undefined, TMUX_PANE: undefined },
      onEvent(event) {
        if (event.type === "environment") {
          environment = event;
          sawEnvironment();
        }
      },
    });

    await environmentDelivered;
    assert.equal(environment?.hasTmux, false);
    assert.equal(environment?.hasTmuxPane, false);
    assert.equal(environment?.cwd, realpathSync(temporaryDirectory));
    await runtime.finish();
  });

  it("returns after prompt acceptance while the child is still running", async () => {
    const marker = join(temporaryDirectory, "accepted.marker");
    const runtime = await start("accepted", { env: { PI_FAKE_MARKER: marker } });

    assert.equal(runtime.kind, "headless");
    assert.equal(runtime.runId, "accepted");
    assert.equal(runtime.state, "running");
    assert.equal(existsSync(marker), false);
    assert.ok(runtime.pid);
    assert.equal(runtime.isAlive(), true);

    const finishing = runtime.finish();
    assert.strictEqual(runtime.finish(), finishing);
    const result = await finishing;
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(readFileSync(marker, "utf8"), "closed\n");
    assert.equal(runtime.state, "finished");
  });

  it("sends initial follow-ups and uses a steer-capable prompt for live messages", async () => {
    const observed: Array<{ command: unknown; message: unknown }> = [];
    const runtime = await start("commands", {
      initialPrompts: ["first", "second", "third"],
      onEvent(event) {
        if (event.type === "request_observed") observed.push(event);
      },
    });

    assert.deepEqual(
      observed.map(({ command, message }) => [command, message]),
      [
        ["prompt", "first"],
        ["follow_up", "second"],
        ["follow_up", "third"],
      ],
    );

    await runtime.send("change direction");
    assert.deepEqual(
      observed.at(-1),
      {
        type: "request_observed",
        command: "prompt",
        message: "change direction",
        streamingBehavior: "steer",
      },
    );
    await runtime.finish();
  });

  it("delivers structured events without exposing response records", async () => {
    const eventTypes: string[] = [];
    let sawAgentStart!: () => void;
    const agentStarted = new Promise<void>((resolve) => {
      sawAgentStart = resolve;
    });
    const runtime = await start("events", {
      onEvent(event) {
        eventTypes.push(event.type);
        if (event.type === "agent_start") sawAgentStart();
      },
    });

    await agentStarted;
    assert.ok(eventTypes.includes("request_observed"));
    assert.ok(eventTypes.includes("agent_start"));
    assert.equal(eventTypes.includes("response"), false);
    await runtime.finish();
  });

  it("reassembles UTF-8 split across stdout chunks", async () => {
    const runtime = await start("split-utf8", { env: { PI_FAKE_MODE: "split-utf8" } });
    assert.equal(runtime.state, "running");
    await runtime.finish();
  });

  it("uses only LF framing and accepts CRLF records", async () => {
    let text: unknown;
    const runtime = await start("unicode-separators", {
      env: { PI_FAKE_MODE: "unicode-separators" },
      onEvent(event) {
        if (event.type === "unicode_event") text = event.text;
      },
    });
    assert.equal(text, "before\u2028middle\u2029after");
    await runtime.finish();
  });

  it("runs independent children in parallel", async () => {
    const [first, second] = await Promise.all([
      start("parallel-a"),
      start("parallel-b"),
    ]);
    assert.notEqual(first.pid, second.pid);
    assert.equal(first.isAlive(), true);
    assert.equal(second.isAlive(), true);

    const results = await Promise.all([first.finish(), second.finish()]);
    assert.deepEqual(results, [{ exitCode: 0 }, { exitCode: 0 }]);
  });

  it("waits for a child that completes normally on its own", async () => {
    const runtime = await start("natural-completion", {
      env: { PI_FAKE_MODE: "natural-completion" },
    });
    assert.equal(runtime.isAlive(), true);
    assert.deepEqual(await runtime.wait(), { exitCode: 0 });
    assert.equal(runtime.state, "finished");
  });

  it("prevents duplicate run and canonical session ownership", async () => {
    const sessionFile = join(temporaryDirectory, "owned.jsonl");
    const runtime = await start("owner", { sessionFile });
    await assert.rejects(
      spawnHeadlessRuntime(spec("other-owner", { sessionFile })),
      /already owned by headless run 'owner'/,
    );
    await assert.rejects(
      spawnHeadlessRuntime(spec("owner", { sessionFile: join(temporaryDirectory, "other.jsonl") })),
      /already owns session file/,
    );
    await runtime.finish();
  });

  it("auto-finishes after agent_end only when the follow-up queue is empty", async () => {
    let decisions = 0;
    const runtime = await start("auto-finish", {
      env: { PI_FAKE_MODE: "agent-end" },
      shouldStopAfterAgentEnd() {
        decisions += 1;
        return true;
      },
    });

    const result = await runtime.wait();
    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(decisions, 1);
    assert.equal(runtime.state, "finished");
  });

  it("does not consult auto-finish while RPC follow-ups are queued", async () => {
    let decisions = 0;
    let sawAgentEnd!: () => void;
    const agentEnded = new Promise<void>((resolve) => {
      sawAgentEnd = resolve;
    });
    const runtime = await start("queued", {
      env: { PI_FAKE_MODE: "queued-agent-end" },
      onEvent(event) {
        if (event.type === "agent_end") sawAgentEnd();
      },
      shouldStopAfterAgentEnd() {
        decisions += 1;
        return true;
      },
    });

    await agentEnded;
    await nextEventTurn();
    assert.equal(decisions, 0);
    assert.equal(runtime.isAlive(), true);
    await runtime.stop();
  });

  it("keeps the runtime open when the agent_end callback returns false", async () => {
    let decisions = 0;
    let sawAgentEnd!: () => void;
    const agentEnded = new Promise<void>((resolve) => {
      sawAgentEnd = resolve;
    });
    const runtime = await start("keep-open", {
      env: { PI_FAKE_MODE: "agent-end" },
      onEvent(event) {
        if (event.type === "agent_end") sawAgentEnd();
      },
      shouldStopAfterAgentEnd() {
        decisions += 1;
        return false;
      },
    });

    await agentEnded;
    await nextEventTurn();
    assert.equal(decisions, 1);
    assert.equal(runtime.isAlive(), true);
    await runtime.send("answer supplied question");
    await runtime.finish();
  });

  it("starts a new turn when messaging an idle parked runtime", async () => {
    let decisions = 0;
    const runtime = await start("parked-answer", {
      env: { PI_FAKE_MODE: "agent-end" },
      shouldStopAfterAgentEnd() {
        decisions += 1;
        return decisions > 1;
      },
    });

    await nextEventTurn();
    assert.equal(runtime.isAlive(), true);
    await runtime.send("answer to the question");
    assert.deepEqual(await runtime.wait(), { exitCode: 0 });
    assert.equal(decisions, 2);
  });

  it("does not execute a leading-slash live message as an RPC extension command", async () => {
    let observedMessage: unknown;
    const runtime = await start("slash-message", {
      onEvent(event) {
        if (event.type === "request_observed" && event.streamingBehavior === "steer") {
          observedMessage = event.message;
        }
      },
    });
    await runtime.send("/dangerous-command argument");
    assert.equal(observedMessage, "\n/dangerous-command argument");
    await runtime.finish();
  });

  it("captures assistant and final auto-retry provider errors", async () => {
    for (const [runId, mode, expected] of [
      ["provider-message", "provider-message", "529 provider overloaded"],
      ["provider-agent", "provider-agent", "nested agent provider failure"],
      ["provider-retry", "retry-failure", "retry budget exhausted"],
    ] as const) {
      const runtime = await start(runId, {
        env: { PI_FAKE_MODE: mode },
        shouldStopAfterAgentEnd: () => true,
      });
      const result = await runtime.wait();
      assert.equal(result.exitCode, 0);
      assert.equal(result.errorMessage, expected);
      assert.equal(runtime.state, "failed");
    }
  });

  it("clears transient provider errors after a successful retry", async () => {
    let agentEnds = 0;
    const runtime = await start("provider-recovered", {
      env: { PI_FAKE_MODE: "provider-recovered" },
      onEvent(event) {
        if (event.type === "agent_end") agentEnds += 1;
      },
      shouldStopAfterAgentEnd: () => true,
    });
    assert.deepEqual(await runtime.wait(), { exitCode: 0 });
    assert.equal(runtime.state, "finished");
    assert.equal(agentEnds, 2, "must wait for the retried run's terminal agent_end");
  });

  it("waits for overflow compaction and its recovery run", async () => {
    let agentEnds = 0;
    let compactionEnded = false;
    const runtime = await start("compaction-recovered", {
      env: { PI_FAKE_MODE: "compaction-recovered" },
      onEvent(event) {
        if (event.type === "agent_end") agentEnds += 1;
        if (event.type === "compaction_end") compactionEnded = true;
      },
      shouldStopAfterAgentEnd: () => true,
    });
    assert.deepEqual(await runtime.wait(), { exitCode: 0 });
    assert.equal(runtime.state, "finished");
    assert.equal(compactionEnded, true);
    assert.equal(agentEnds, 2, "must wait for the post-compaction terminal agent_end");
  });

  it("reports malformed startup output and bounded stderr", async () => {
    await assert.rejects(
      spawnHeadlessRuntime(
        spec("malformed-startup", { env: { PI_FAKE_MODE: "startup-malformed" } }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof HeadlessError);
        assert.match(error.message, /Malformed RPC JSON/);
        assert.match(error.message, /fake startup refused RPC/);
        return true;
      },
    );

    const runtime = await start("stderr-limit", { env: { PI_FAKE_MODE: "stderr-overflow" } });
    await runtime.send("exit now");
    const result = await runtime.wait();
    assert.equal(result.exitCode, 9);
    assert.match(result.errorMessage ?? "", /code 9/);
    assert.equal(Buffer.byteLength(result.stderr ?? ""), 64 * 1024);
  });

  it("ignores malformed lines after a valid protocol record", async () => {
    const runtime = await start("late-malformed", {
      env: { PI_FAKE_MODE: "malformed-after-valid" },
    });
    const result = await runtime.finish();
    assert.equal(result.errorMessage, undefined);
    assert.equal(runtime.state, "finished");
  });

  it("reports command rejection, pre-acceptance nonzero exit, and spawn failure", async () => {
    await assert.rejects(
      spawnHeadlessRuntime(spec("rejected", { env: { PI_FAKE_MODE: "reject" } })),
      /fake command rejection/,
    );
    await assert.rejects(
      spawnHeadlessRuntime(
        spec("nonzero-startup", { env: { PI_FAKE_MODE: "nonzero-startup" } }),
      ),
      /code 42|provider bootstrap exited/,
    );
    await assert.rejects(
      spawnHeadlessRuntime(spec("spawn-failure", { command: join(temporaryDirectory, "missing") })),
      /Failed to spawn headless run 'spawn-failure'/,
    );
  });

  it("times out a child that never accepts the initial prompt", async () => {
    await assert.rejects(
      spawnHeadlessRuntime(
        spec("startup-timeout", {
          env: { PI_FAKE_MODE: "never-accept", PI_FAKE_SIGNAL_POLICY: "ignore" },
          startupTimeoutMs: 30,
          terminationGraceMs: 30,
        }),
      ),
      /startup timed out/,
    );
  });

  it("rejects startup when cancellation races with prompt acceptance", async () => {
    const controller = new AbortController();
    await assert.rejects(
      spawnHeadlessRuntime(
        spec("startup-cancelled", {
          env: { PI_FAKE_SIGNAL_POLICY: "ignore" },
          signal: controller.signal,
          terminationGraceMs: 30,
          onEvent(event) {
            if (event.type === "request_observed") controller.abort();
          },
        }),
      ),
      /startup was cancelled/,
    );
  });

  it("wait abort terminates, escalates, and resolves the shared result", async () => {
    const runtime = await start("abort", {
      env: { PI_FAKE_SIGNAL_POLICY: "ignore" },
      terminationGraceMs: 30,
    });
    const controller = new AbortController();
    const waiting = runtime.wait(controller.signal);
    controller.abort();

    const result = await waiting;
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /SIGKILL/);
    assert.equal(runtime.isAlive(), false);
  });

  it("stop and finish are idempotent and wait resolves exactly once", async () => {
    const runtime = await start("idempotent", {
      env: { PI_FAKE_SIGNAL_POLICY: "ignore" },
      terminationGraceMs: 30,
    });
    const first = runtime.stop();
    const second = runtime.stop();
    const waited = runtime.wait();
    const [firstResult, secondResult, waitedResult] = await Promise.all([first, second, waited]);

    assert.strictEqual(firstResult, secondResult);
    assert.strictEqual(secondResult, waitedResult);
    assert.equal(runtime.isAlive(), false);
    assert.strictEqual(await runtime.finish(), firstResult);
  });

  it("rejects an in-flight RPC deterministically when stopping", async () => {
    const runtime = await start("pending-request", {
      env: { PI_FAKE_MODE: "never-accept-steer" },
    });
    const steering = runtime.send("remain pending");
    const stopped = runtime.stop();
    await assert.rejects(steering, /closed|terminated|code/);
    assert.strictEqual(await stopped, await runtime.wait());
  });

  it("invokes wait progress ticks for protocol activity and close", async () => {
    const runtime = await start("ticks");
    let ticks = 0;
    const waiting = runtime.wait(undefined, () => {
      ticks += 1;
    });
    await runtime.send("tick");
    await runtime.finish();
    await waiting;
    assert.ok(ticks >= 3);
  });
});
