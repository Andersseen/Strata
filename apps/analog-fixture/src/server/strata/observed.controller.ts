import { Controller, Get, Post } from "@strata-sc/core";
import { StrataAnalogHttpError, jsonResponse, streamResponse } from "@strata-sc/analog";
import type { StrataAnalogRequestObservation } from "@strata-sc/analog";

/** Fixture-only synthetic private value: it must never reach an observation. */
export const OBSERVED_CANARY = "fixture-observed-private-canary";

/** A consumer-owned, in-memory record: observations and the cleanups that preceded them. */
export type ObservedEntry =
  | { readonly kind: "cleanup"; readonly resource: string }
  | { readonly kind: "observation"; readonly observation: StrataAnalogRequestObservation };

const log: ObservedEntry[] = [];

export const record = (entry: ObservedEntry): void => {
  log.push(entry);
};

/** The structured line a consumer would hand to its own logger. */
export function toLogLine(observation: StrataAnalogRequestObservation): string {
  return JSON.stringify({
    event: "strata.request",
    method: observation.route.method,
    route: observation.route.path,
    outcome: observation.outcome,
    status: observation.status ?? null,
    streaming: observation.streaming,
    cleanup: observation.cleanup,
    invocationMs: Math.round(observation.invocationMs * 100) / 100,
    elapsedMs: Math.round(observation.elapsedMs * 100) / 100,
  });
}

/** Controllers observed by the fixture plugin; each request registers one cleanup. */
@Controller("/api/strata/observed")
export class ObservedController {
  @Get("/ok/:id")
  ok() {
    return { ok: true };
  }

  @Get("/expected")
  expected() {
    throw new StrataAnalogHttpError(409, "conflict", `private ${OBSERVED_CANARY}`, {
      cause: new Error(OBSERVED_CANARY),
    });
  }

  @Get("/unexpected")
  unexpected() {
    throw new Error(`private ${OBSERVED_CANARY}`);
  }

  @Get("/stream")
  stream() {
    return streamResponse(
      (async function* () {
        yield "one;";
        yield "two;";
        await Promise.resolve();
        yield "three;";
      })(),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}

/** Registered WITHOUT an observer, so reading the log never adds to it. */
@Controller("/api/strata/observed-log")
export class ObservedLogController {
  @Get()
  read() {
    return jsonResponse([...log]);
  }

  @Post("/reset")
  reset() {
    log.length = 0;
    return jsonResponse({ reset: true });
  }
}
