import { Controller, Get, Post } from "@strata-sc/core";
import { jsonResponse, streamResponse } from "@strata-sc/analog";
import type {
  StrataAnalogCleanup,
  StrataAnalogGuard,
  StrataAnalogInterceptor,
  StrataAnalogRequest,
} from "@strata-sc/analog";

import { STREAM_CANARY, release, waitFor } from "./stream-barrier";

/** Fixture-only counters, read back by the harness through `GET /api/strata/stream/stats`. */
const stats = { opened: 0, closed: 0, cleanups: 0 };
const open = new Set<string>();

/** A request-scoped resource whose lifetime matters: reading it after close fails. */
export class ChunkReader {
  #closed = false;

  constructor(readonly id: string) {
    stats.opened++;
    open.add(id);
  }

  get closed(): boolean {
    return this.#closed;
  }

  read(index: number): string {
    if (this.#closed) throw new Error(`reader ${this.id} was read after close (${STREAM_CANARY})`);
    return `${this.id}:${String(index)};`;
  }

  close(): void {
    if (this.#closed) throw new Error(`reader ${this.id} closed twice`);
    this.#closed = true;
    stats.closed++;
    open.delete(this.id);
  }
}

export function openChunkReader(
  request: StrataAnalogRequest,
  onCleanup: (cleanup: StrataAnalogCleanup) => void,
): ChunkReader {
  const reader = new ChunkReader(
    request.query["id"] === undefined ? "anon" : String(request.query["id"]),
  );
  onCleanup(() => {
    stats.cleanups++;
    reader.close();
    if (request.query["cleanupFailure"] === "1")
      throw new Error(`cleanup failed (${STREAM_CANARY})`);
  });
  return reader;
}

/** Only the three streaming routes own a reader; stats and release must not count as one. */
export const needsReader = (path: string): boolean => /\/(owned|eager|fail)$/.test(path);

export const streamingGuard: StrataAnalogGuard = ({ request, route }) =>
  route.path.startsWith("/api/strata/stream/") && request.query["deny"] === "1"
    ? { allow: false, status: 403 }
    : { allow: true };

/** `?replace=1` swaps the owned streaming response for a JSON one. */
export const streamingInterceptor: StrataAnalogInterceptor = async ({ request }, next) => {
  const result = await next();
  if (request.query["replace"] === "1") return jsonResponse({ replaced: true });
  if (result instanceof Response) void result.headers.get("content-type");
  return result;
};

const CHUNKS = 3;

@Controller("/api/strata/stream")
export class StreamingController {
  constructor(private readonly reader: ChunkReader | undefined = undefined) {}

  /** Opt-in streaming ownership: the reader stays open until the body ends. */
  @Get("/owned")
  owned(request: StrataAnalogRequest) {
    const reader = this.reader;
    if (!reader) throw new Error("no reader");
    const gated = request.query["gate"] === "1";
    const id = reader.id;
    return streamResponse(
      (async function* () {
        for (let index = 0; index < CHUNKS; index++) {
          if (gated && index === 1) await waitFor(id);
          yield reader.read(index);
        }
      })(),
      { headers: { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" } },
    );
  }

  /** The pre-0.7 behaviour: an ordinary Response over a ReadableStream keeps no scope open. */
  @Get("/eager")
  eager() {
    const reader = this.reader;
    if (!reader) throw new Error("no reader");
    let index = 0;
    return new Response(
      new ReadableStream<string>({
        pull(controller) {
          controller.enqueue(
            reader.closed ? `${reader.id}:closed-before-use;` : reader.read(index),
          );
          if (++index === CHUNKS) controller.close();
        },
      }).pipeThrough(new TextEncoderStream()),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  /** A producer that fails after its first chunk, with a private message. */
  @Get("/fail")
  fail() {
    const reader = this.reader;
    if (!reader) throw new Error("no reader");
    return streamResponse(
      (async function* () {
        yield reader.read(0);
        throw new Error(`producer failed (${STREAM_CANARY})`);
      })(),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  @Get("/stats")
  stats() {
    return jsonResponse({ ...stats, open: [...open].sort() });
  }

  @Post("/release")
  release(request: StrataAnalogRequest) {
    release(String(request.query["id"] ?? ""));
    return jsonResponse({ released: true });
  }
}
