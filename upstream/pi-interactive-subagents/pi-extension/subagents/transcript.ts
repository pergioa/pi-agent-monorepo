import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs";

export interface TranscriptBlock {
  label: string;
  text: string;
}

export interface TranscriptCache {
  size?: number;
  mtimeMs?: number;
  dev?: number;
  ino?: number;
  offset?: number;
  entries?: number;
  seededEntries?: number;
  blocks: TranscriptBlock[];
}

const LIVE_UPDATE_MS = 200;

export function liveTranscriptPath(sessionFile: string): string {
  return `${sessionFile}.live.json`;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function messageBlocks(value: unknown): TranscriptBlock[] {
  const message = asObject(value);
  if (!message) return [];
  const label = message.role === "assistant" ? "Assistant" : message.role === "toolResult"
    ? `Tool result${typeof message.toolName === "string" ? ` · ${message.toolName}` : ""}`
    : message.role === "user" ? "User" : null;
  if (!label) return [];
  if (message.role === "user" && typeof message.content === "string") {
    return message.content ? [{ label, text: message.content }] : [];
  }
  if (!Array.isArray(message.content)) return [];

  const blocks: TranscriptBlock[] = [];
  for (const value of message.content) {
    const part = asObject(value);
    if (!part) continue;
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
      blocks.push({ label: "Reasoning", text: part.thinking });
    } else if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ label, text: part.text });
    } else if (part.type === "toolCall" && typeof part.name === "string") {
      blocks.push({ label: `Tool call · ${part.name}`, text: JSON.stringify(part.arguments ?? {}, null, 2) });
    } else if (part.type === "image") {
      const mime = typeof part.mimeType === "string" ? ` · ${part.mimeType}` : "";
      blocks.push({ label, text: `[Image${mime}]` });
    } else if (message.role === "toolResult" && typeof part.type === "string") {
      blocks.push({ label, text: `[${part.type} output]` });
    }
  }
  return blocks;
}

/** Read only complete, newly appended JSONL lines. A replacement/truncation resets the cache. */
export function readTranscript(sessionFile: string, cache: TranscriptCache): TranscriptBlock[] {
  try {
    const { size, mtimeMs, dev, ino } = statSync(sessionFile);
    if (size === cache.size && mtimeMs === cache.mtimeMs && dev === cache.dev && ino === cache.ino) return cache.blocks;
    if (cache.offset === undefined || size < (cache.size ?? 0) || dev !== cache.dev || ino !== cache.ino || size === cache.size) {
      cache.offset = 0;
      cache.entries = 0;
      cache.seededEntries = 0;
      cache.blocks = [];
    }
    const fd = openSync(sessionFile, "r");
    try {
      let position = cache.offset;
      let pending = Buffer.alloc(0);
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (position + pending.length < size) {
        const length = Math.min(chunk.length, size - position - pending.length);
        const count = readSync(fd, chunk, 0, length, position + pending.length);
        if (!count) break;
        const data = Buffer.concat([pending, chunk.subarray(0, count)]);
        let start = 0;
        let end: number;
        while ((end = data.indexOf(10, start)) !== -1) {
          const line = data.toString("utf8", start, end);
          position += end - start + 1;
          start = end + 1;
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (cache.entries === 0 && entry.type === "session" && Number.isSafeInteger(entry.subagentSeededEntries) && entry.subagentSeededEntries >= 0) {
              cache.seededEntries = entry.subagentSeededEntries;
            }
            if (entry.type === "message" && (cache.entries === 0 || cache.entries! > (cache.seededEntries ?? 0))) {
              cache.blocks.push(...messageBlocks(entry.message));
            }
          } catch {
            // A malformed completed line must not break the inspector.
          }
          cache.entries!++;
        }
        pending = Buffer.from(data.subarray(start));
      }
      cache.offset = position;
    } finally {
      closeSync(fd);
    }
    cache.size = size;
    cache.mtimeMs = mtimeMs;
    cache.dev = dev;
    cache.ino = ino;
  } catch {
    // The child may not have created its session file yet.
  }
  return cache.blocks;
}

export function readLiveTranscript(sessionFile: string): TranscriptBlock[] {
  try {
    const snapshot = JSON.parse(readFileSync(liveTranscriptPath(sessionFile), "utf8"));
    return asObject(snapshot)?.role === "assistant" ? messageBlocks(snapshot) : [];
  } catch {
    return [];
  }
}

/** Child-side snapshot of the currently streaming assistant message (both RPC and tmux). */
export function createLiveTranscriptRecorder(sessionFile?: string) {
  const path = sessionFile ? liveTranscriptPath(sessionFile) : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let message: unknown;
  let lastWrite = 0;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    message = undefined;
    if (path) {
      try { unlinkSync(path); } catch {}
    }
  }

  function write() {
    timer = undefined;
    if (!path || !asObject(message) || asObject(message)?.role !== "assistant") return;
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(message), "utf8");
      renameSync(tmp, path);
      lastWrite = Date.now();
    } catch {
      try { unlinkSync(tmp); } catch {}
    }
  }

  return {
    start: clear,
    update(value: unknown) {
      if (!path || !asObject(value) || asObject(value)?.role !== "assistant") return;
      message = value;
      if (timer) return;
      if (Date.now() - lastWrite >= LIVE_UPDATE_MS) write();
      else timer = setTimeout(write, LIVE_UPDATE_MS - (Date.now() - lastWrite));
    },
    end: clear,
    stop: clear,
  };
}
