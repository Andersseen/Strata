import { StrataAnalogHttpError } from "./http-error.js";
import { StrataAnalogInputError } from "./input-error.js";
import type { StrataAnalogRouteInfo } from "./register-controllers.js";

/**
 * How a Strata-owned controller invocation ended. Finite and safe to log.
 *
 * - `completed`: guards allowed it and the controller returned; cleanup succeeded.
 * - `guard-denied`: a guard answered 401/403; no controller was constructed.
 * - `input-rejected`: validated request input was rejected (400/413/415).
 * - `application-error`: the invocation threw a `StrataAnalogHttpError`.
 * - `failed`: the invocation threw anything else; the error propagates to Nitro.
 * - `cleanup-failed`: a cleanup callback failed. It takes precedence over every
 *   other outcome, because the invocation did not release what it owned.
 * - `stream-completed` / `stream-failed` / `stream-cancelled`: the terminal
 *   outcome of a `streamResponse()` body this invocation returned.
 */
export type StrataAnalogRequestOutcome =
  | "completed"
  | "guard-denied"
  | "input-rejected"
  | "application-error"
  | "failed"
  | "cleanup-failed"
  | "stream-completed"
  | "stream-failed"
  | "stream-cancelled";

/** The part of the lifecycle the invocation was in when it reached its outcome. */
export type StrataAnalogRequestPhase = "guards" | "execution" | "cleanup" | "stream";

/**
 * A readonly, structured fact about one finished Strata controller invocation.
 * Built only from registered route metadata and Strata's own classification:
 * it never carries request values, headers, bodies, error objects or messages.
 */
export interface StrataAnalogRequestObservation {
  /** The registered route (method, route template, controller and handler names). */
  readonly route: StrataAnalogRouteInfo;
  readonly outcome: StrataAnalogRequestOutcome;
  /**
   * The status Strata itself answered with: 401/403 for a guard denial, 400/413/415
   * for rejected input, the `StrataAnalogHttpError` status. `undefined` whenever
   * Nitro owns the final status (a returned value or `Response`, an unexpected
   * failure, a stream, a cleanup failure). Never guessed.
   */
  readonly status: number | undefined;
  readonly phase: StrataAnalogRequestPhase;
  /** Whether this invocation returned an owned `streamResponse()`. */
  readonly streaming: boolean;
  /** Whether every cleanup callback of the invocation completed without error. */
  readonly cleanup: "completed" | "failed";
  /**
   * Milliseconds, on a monotonic clock, from the start of the route handler
   * until guards, interceptors and the controller handler had settled, before
   * cleanup. For a stream this is the time until the stream was returned, not
   * the time to produce its body.
   */
  readonly invocationMs: number;
  /**
   * Milliseconds, on the same clock, from the start of the route handler until
   * this observation, after cleanup settled. For a stream it is the full
   * observed lifetime of the body.
   */
  readonly elapsedMs: number;
}

/**
 * Receives each Strata invocation's observation exactly once, synchronously, in
 * the request's own call stack. Its return value is ignored and never awaited;
 * anything it throws, or rejects with, is discarded. It cannot change the
 * response or the error the request settles with.
 */
export type StrataAnalogRequestObserver = (observation: StrataAnalogRequestObservation) => void;

/** How a streamed body ended, before cleanup. */
export type StreamTerminal = "completed" | "failed" | "cancelled";

const STREAM_OUTCOME = {
  completed: "stream-completed",
  failed: "stream-failed",
  cancelled: "stream-cancelled",
} as const satisfies Record<StreamTerminal, StrataAnalogRequestOutcome>;

function now(): number {
  return globalThis.performance.now();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The observation of one route-handler call. Internal: created only when an
 * observer is registered, owned by that call, and dropped after it emits.
 */
export class InvocationObservation {
  readonly #route: StrataAnalogRouteInfo;
  readonly #observer: StrataAnalogRequestObserver;
  readonly #startedAt = now();
  #invokedAt: number | undefined;
  #phase: "guards" | "execution" = "guards";
  #emitted = false;

  constructor(route: StrataAnalogRouteInfo, observer: StrataAnalogRequestObserver) {
    this.#route = route;
    this.#observer = observer;
  }

  enterExecution(): void {
    this.#phase = "execution";
  }

  /** Marks the end of guards, interceptors and the handler; the first call wins. */
  invoked(): void {
    this.#invokedAt ??= now();
  }

  /** Guards (and possibly the controller) finished and cleanup succeeded. */
  completed(denial: 401 | 403 | undefined): void {
    if (denial === undefined) {
      this.#emit("completed", undefined, "execution", false, "completed");
    } else {
      this.#emit("guard-denied", denial, "guards", false, "completed");
    }
  }

  /** The invocation threw `error` and every cleanup succeeded. */
  failed(error: unknown): void {
    if (error instanceof StrataAnalogInputError) {
      this.#emit("input-rejected", error.status, this.#phase, false, "completed");
    } else if (error instanceof StrataAnalogHttpError) {
      this.#emit("application-error", error.status, this.#phase, false, "completed");
    } else {
      this.#emit("failed", undefined, this.#phase, false, "completed");
    }
  }

  cleanupFailed(streaming = false): void {
    this.#emit("cleanup-failed", undefined, "cleanup", streaming, "failed");
  }

  /** Stable, `this`-free callback handed to the stream that now owns the scope. */
  readonly streamSettled = (terminal: StreamTerminal, cleanupFailed: boolean): void => {
    if (cleanupFailed) {
      this.cleanupFailed(true);
    } else {
      this.#emit(STREAM_OUTCOME[terminal], undefined, "stream", true, "completed");
    }
  };

  #emit(
    outcome: StrataAnalogRequestOutcome,
    status: number | undefined,
    phase: StrataAnalogRequestPhase,
    streaming: boolean,
    cleanup: "completed" | "failed",
  ): void {
    if (this.#emitted) return;
    this.#emitted = true;

    const finishedAt = now();
    const observation: StrataAnalogRequestObservation = Object.freeze({
      route: this.#route,
      outcome,
      status,
      phase,
      streaming,
      cleanup,
      invocationMs: (this.#invokedAt ?? finishedAt) - this.#startedAt,
      elapsedMs: finishedAt - this.#startedAt,
    });

    try {
      const returned: unknown = this.#observer(observation);
      // Not awaited and not supported, but a rejection must not become unhandled.
      if (isThenable(returned)) void Promise.resolve(returned).catch(() => undefined);
    } catch {
      // Observability is not part of the response contract.
    }
  }
}
