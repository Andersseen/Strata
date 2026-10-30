import { Controller, Get, Post } from "@strata-sc/core";
import { jsonResponse, streamResponse } from "@strata-sc/analog";
import type { StrataAnalogRequest, StrataAnalogRequestObservation } from "@strata-sc/analog";

/** Fixture-only synthetic private value: it must never reach the correlation log. */
export const CORRELATED_CANARY = "fixture-correlated-private-canary";

/** One consumer-owned fact. `tag` is the synthetic identity the client chose for the request. */
export type CorrelatedEntry =
  | {
      readonly kind: "stage";
      readonly stage: string;
      readonly tag: string;
      readonly correlationId: string | undefined;
    }
  | { readonly kind: "observation"; readonly observation: StrataAnalogRequestObservation };

const log: CorrelatedEntry[] = [];

export const recordCorrelated = (entry: CorrelatedEntry): void => {
  log.push(entry);
};

export const tagOf = (request: StrataAnalogRequest): string =>
  request.url.searchParams.get("tag") ?? "";

export const stage = (name: string, request: StrataAnalogRequest): void => {
  log.push({
    kind: "stage",
    stage: name,
    tag: tagOf(request),
    correlationId: request.correlationId,
  });
};

const numberBody = {
  "~standard": {
    version: 1 as const,
    vendor: "fixture",
    types: undefined as unknown as {
      readonly input: { n: number };
      readonly output: { n: number };
    },
    validate: (value: unknown) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { n?: unknown }).n === "number"
        ? { value: { n: (value as { n: number }).n } }
        : { issues: [{ message: "fixture-private-validation-detail" }] },
  },
};

/** Registered with `requestCorrelation: true`; every stage records the id it saw. */
@Controller("/api/strata/correlated")
export class CorrelatedController {
  @Get("/ok/:id")
  async ok(request: StrataAnalogRequest) {
    stage("handler:before", request);
    // Interleave overlapping requests: the delay depends on the synthetic identity.
    await new Promise((resolve) => setTimeout(resolve, Number(tagOf(request).length % 5) * 4));
    stage("handler:after", request);
    return { ok: true };
  }

  @Post("/validated")
  async validated(request: StrataAnalogRequest) {
    stage("handler:before", request);
    return request.readValidatedJson(numberBody);
  }

  @Get("/unexpected")
  unexpected(request: StrataAnalogRequest) {
    stage("handler:before", request);
    throw new Error(`private ${CORRELATED_CANARY}`);
  }

  @Get("/stream")
  stream(request: StrataAnalogRequest) {
    stage("handler:before", request);
    return streamResponse(
      (async function* () {
        yield "one;";
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield "two;";
      })(),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}

/** Registered WITHOUT an observer or correlation, so reading the log never adds to it. */
@Controller("/api/strata/correlated-log")
export class CorrelatedLogController {
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
