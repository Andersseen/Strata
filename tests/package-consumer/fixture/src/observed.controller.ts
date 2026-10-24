import { Controller, Get } from "@strata-sc/core";

import { StrataAnalogHttpError, streamResponse } from "@strata-sc/analog";
import type {
  StrataAnalogRequestObservation,
  StrataAnalogRequestObserver,
  StrataAnalogRequestOutcome,
  StrataAnalogRequestPhase,
} from "@strata-sc/analog";

/** Every observation, as a consumer-owned structured logger would receive it. */
export const observed: StrataAnalogRequestObservation[] = [];

export const PRIVATE = "package-consumer-private-canary";

/** Type-level check of the public contract: these must stay the documented finite sets. */
export const outcomes: readonly StrataAnalogRequestOutcome[] = [
  "completed",
  "guard-denied",
  "input-rejected",
  "application-error",
  "failed",
  "cleanup-failed",
  "stream-completed",
  "stream-failed",
  "stream-cancelled",
];
export const phases: readonly StrataAnalogRequestPhase[] = [
  "guards",
  "execution",
  "cleanup",
  "stream",
];

export const observer: StrataAnalogRequestObserver = (observation) => {
  observed.push(observation);
};

@Controller("/api/observed")
export class ObservedController {
  @Get("/ok/:id")
  ok() {
    return { ok: true };
  }

  @Get("/expected")
  expected() {
    throw new StrataAnalogHttpError(409, "conflict", `private ${PRIVATE}`);
  }

  @Get("/unexpected")
  unexpected() {
    throw new Error(`private ${PRIVATE}`);
  }

  @Get("/stream")
  stream() {
    return streamResponse(
      (async function* () {
        yield "a;";
        await Promise.resolve();
        yield "b;";
      })(),
    );
  }
}
