#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const mode = process.env.PI_FAKE_MODE ?? "hold";
const marker = process.env.PI_FAKE_MARKER;
let input = "";
let closed = false;

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function shutdown(code = 0) {
  if (closed) return;
  closed = true;
  if (marker) writeFileSync(marker, "closed\n");
  process.exit(code);
}

if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) {
  process.stderr.write("missing --mode rpc\n");
  process.exit(64);
}

if (mode === "startup-malformed") {
  process.stdout.write("not-json startup failure\n");
  process.stderr.write("fake startup refused RPC\n");
  process.exit(3);
}

if (process.env.PI_FAKE_SIGNAL_POLICY === "ignore") {
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGTERM", () => shutdown(0));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\n");
  while (newline !== -1) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line !== "") handleRequest(JSON.parse(line));
    newline = input.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (process.env.PI_FAKE_STDIN_POLICY !== "ignore") shutdown(0);
});

function accept(request) {
  emit({
    type: "request_observed",
    command: request.type,
    message: request.message,
    streamingBehavior: request.streamingBehavior,
  });
  emit({ type: "response", id: request.id, command: request.type, success: true });
}

function handleRequest(request) {
  if (mode === "never-accept") return;
  if (mode === "never-accept-steer" && request.message === "remain pending") return;
  if (mode === "nonzero-startup") {
    process.stderr.write("provider bootstrap exited\n");
    shutdown(42);
    return;
  }
  if (mode === "reject") {
    emit({
      type: "response",
      id: request.id,
      command: request.type,
      success: false,
      error: "fake command rejection",
    });
    return;
  }

  if (mode === "split-utf8" && request.type === "prompt") {
    const response = Buffer.from(
      `${JSON.stringify({
        type: "response",
        id: request.id,
        command: request.type,
        success: true,
        note: "café",
      })}\n`,
    );
    const split = response.indexOf(Buffer.from("é")) + 1;
    process.stdout.write(response.subarray(0, split));
    setImmediate(() => process.stdout.write(response.subarray(split)));
    return;
  }

  if (mode === "unicode-separators" && request.type === "prompt") {
    process.stdout.write(
      `${JSON.stringify({ type: "unicode_event", text: "before\u2028middle\u2029after" })}\r\n`,
    );
  }

  accept(request);
  if (request.type !== "prompt" || request.streamingBehavior !== undefined) {
    if (mode === "accepted-nonzero" && request.message === "exit now") {
      setImmediate(() => shutdown(17));
    } else if (mode === "stderr-overflow" && request.message === "exit now") {
      process.stderr.write(Buffer.alloc(80 * 1024, "x"));
      setImmediate(() => shutdown(9));
    }
    if (request.streamingBehavior !== undefined && mode !== "agent-end") return;
  }

  emit({
    type: "environment",
    hasTmux: process.env.TMUX !== undefined,
    hasTmuxPane: process.env.TMUX_PANE !== undefined,
    cwd: process.cwd(),
  });
  emit({ type: "agent_start" });

  if (mode === "natural-completion") {
    setTimeout(() => shutdown(0), 20);
  } else if (mode === "agent-end") {
    emit({ type: "agent_end", messages: [] });
  } else if (mode === "queued-agent-end") {
    emit({ type: "queue_update", steering: [], followUp: ["queued work"] });
    emit({ type: "agent_end", messages: [] });
  } else if (mode === "provider-message") {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "529 provider overloaded",
      },
    });
    emit({ type: "agent_end", messages: [] });
  } else if (mode === "provider-agent") {
    emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "nested agent provider failure",
        },
      ],
    });
  } else if (mode === "retry-failure") {
    emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "retry budget exhausted" }],
    });
    emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: "retry budget exhausted" });
  } else if (mode === "provider-recovered") {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "transient provider failure",
      },
    });
    emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "transient provider failure" }],
    });
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0 });
    setTimeout(() => {
      emit({ type: "agent_start" });
      emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [] },
      });
      emit({ type: "auto_retry_end", success: true, attempt: 1 });
      setTimeout(() => {
        emit({
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "stop", content: [] }],
        });
      }, 20);
    }, 0);
  } else if (mode === "compaction-recovered") {
    emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "context window exceeded" },
    });
    emit({
      type: "agent_end",
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "context window exceeded" },
      ],
    });
    emit({ type: "compaction_start", reason: "overflow" });
    setTimeout(() => {
      emit({
        type: "compaction_end",
        reason: "overflow",
        result: { summary: "compacted" },
        aborted: false,
        willRetry: true,
      });
      setTimeout(() => {
        emit({ type: "agent_start" });
        emit({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop", content: [] },
        });
        emit({
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "stop", content: [] }],
        });
      }, 20);
    }, 20);
  } else if (mode === "malformed-after-valid") {
    process.stdout.write("{ broken after handshake\n");
  }
}
