/**
 * L1: Durable event replay for pi-windsurf events.
 *
 * Events emitted via pi.events.emit() are in-memory only. If a dashboard or
 * overlay subscriber briefly unsubscribes (toggle, reconnect), it permanently
 * misses events. This module provides:
 *
 * 1. appendEvent() — appends to a durable JSONL log with monotonic seq.
 * 2. readEventsSince() — reads events with seq > lastSeenSeq from the log.
 * 3. createReplayBus() — an event bus with onWithReplay() that replays missed
 *    events from the durable log before attaching a live listener, then dedups
 *    by seq so events delivered both ways fire exactly once.
 *
 * The JSONL log is written to ~/.config/opencode-windsurf-auth/events.jsonl
 * with a sidecar .seq file for fast seq lookup. The log is tail-capped to
 * prevent unbounded growth.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const EVENT_LOG_DIR = path.join(os.homedir(), ".config", "opencode-windsurf-auth");
const EVENT_LOG_PATH = path.join(EVENT_LOG_DIR, "events.jsonl");
const SEQ_FILE_PATH = path.join(EVENT_LOG_DIR, "events.seq");
const MAX_LOG_BYTES = 512 * 1024; // 512KB tail cap

export interface WindsurfEvent {
  type: string;
  seq: number;
  timestamp: string;
  data: unknown;
}

let inProcessSeq = 0;

/** Read the persisted sequence counter (or 0 if missing). */
function readPersistedSeq(): number {
  try {
    return parseInt(fs.readFileSync(SEQ_FILE_PATH, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** Persist the sequence counter atomically. */
function persistSeq(seq: number): void {
  try {
    fs.writeFileSync(SEQ_FILE_PATH, String(seq), { mode: 0o600 });
  } catch {}
}

/** Ensure the log directory exists. */
function ensureLogDir(): void {
  try {
    fs.mkdirSync(EVENT_LOG_DIR, { recursive: true, mode: 0o700 });
  } catch {}
}

/** Tail-cap the log file if it exceeds MAX_LOG_BYTES. Keeps the last MAX_LOG_BYTES. */
function tailCapLog(): void {
  try {
    const stat = fs.statSync(EVENT_LOG_PATH);
    if (stat.size <= MAX_LOG_BYTES) return;
    const fd = fs.openSync(EVENT_LOG_PATH, "r");
    try {
      const buf = Buffer.alloc(MAX_LOG_BYTES);
      fs.readSync(fd, buf, 0, MAX_LOG_BYTES, stat.size - MAX_LOG_BYTES);
      const firstNewline = buf.indexOf(0x0a);
      const trimmed = firstNewline >= 0 ? buf.subarray(firstNewline + 1) : buf;
      fs.writeFileSync(EVENT_LOG_PATH, trimmed);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

/** Append an event to the durable JSONL log. Returns the event with seq. */
export function appendEvent(type: string, data: unknown): WindsurfEvent {
  if (inProcessSeq === 0) inProcessSeq = readPersistedSeq();
  inProcessSeq += 1;
  const event: WindsurfEvent = {
    type,
    seq: inProcessSeq,
    timestamp: new Date().toISOString(),
    data,
  };
  ensureLogDir();
  try {
    fs.appendFileSync(EVENT_LOG_PATH, JSON.stringify(event) + "\n", { mode: 0o600 });
  } catch {}
  persistSeq(inProcessSeq);
  // Tail-cap every 128 events to amortize the stat cost.
  if (inProcessSeq % 128 === 0) tailCapLog();
  return event;
}

/** Read all events with seq > lastSeenSeq from the durable log. */
export function readEventsSince(lastSeenSeq: number): WindsurfEvent[] {
  try {
    const content = fs.readFileSync(EVENT_LOG_PATH, "utf8");
    const events: WindsurfEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as WindsurfEvent;
        if (event.seq > lastSeenSeq) events.push(event);
      } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

type EventCallback = (event: WindsurfEvent) => void;

/**
 * L1: Replay-capable event bus. Subscribers that briefly disconnected can
 * re-subscribe with onWithReplay() and receive all events they missed,
 * deduplicated by seq so no event fires twice.
 */
export class ReplayEventBus {
  #listeners = new Map<string, Set<EventCallback>>();
  #globalListeners = new Set<EventCallback>();

  /** Emit an event to all live listeners and persist it to the durable log. */
  emit(type: string, data: unknown): WindsurfEvent {
    const event = appendEvent(type, data);
    const typeListeners = this.#listeners.get(type);
    if (typeListeners) {
      for (const cb of typeListeners) {
        try { cb(event); } catch {}
      }
    }
    for (const cb of this.#globalListeners) {
      try { cb(event); } catch {}
    }
    return event;
  }

  /** Subscribe to a specific event type (live only). Returns unsubscribe. */
  on(type: string, callback: EventCallback): () => void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.#listeners.set(type, listeners);
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) this.#listeners.delete(type);
    };
  }

  /** Subscribe to all events (live only). Returns unsubscribe. */
  onAny(callback: EventCallback): () => void {
    this.#globalListeners.add(callback);
    return () => { this.#globalListeners.delete(callback); };
  }

  /**
   * L1: Subscribe with catch-up replay from the durable event log.
   *
   * Replays all events with seq > lastSeenSeq directly to the callback BEFORE
   * attaching the live listener. Live events with seq <= the max replayed seq
   * are suppressed (dedup). Events without a seq (shouldn't happen in this
   * implementation since all events get seq from appendEvent) always deliver.
   *
   * @param type         Event type to subscribe to.
   * @param lastSeenSeq  Last seq the caller processed; events with seq > this
   *                     are replayed. Pass 0 to replay everything.
   * @param callback     Receives both replayed and live events.
   * @returns unsubscribe handle (detaches the live listener).
   */
  onWithReplay(type: string, lastSeenSeq: number, callback: EventCallback): () => void {
    let maxReplayedSeq = lastSeenSeq;
    try {
      const missed = readEventsSince(lastSeenSeq);
      for (const event of missed) {
        if (event.type !== type) continue;
        try { callback(event); } catch {}
        if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
      }
    } catch {
      // Log read failure is non-fatal — fall through to live-only.
    }

    const liveCallback: EventCallback = (event) => {
      if (event.seq <= maxReplayedSeq) return;
      callback(event);
    };
    return this.on(type, liveCallback);
  }

  /** Dispose all subscriptions. */
  dispose(): void {
    this.#listeners.clear();
    this.#globalListeners.clear();
  }
}

/** Global singleton replay event bus for pi-windsurf events. */
export const windsurfEventBus = new ReplayEventBus();
