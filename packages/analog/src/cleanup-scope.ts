import { StrataAnalogConfigurationError } from "./errors.js";

/**
 * Releases a resource created for one controller invocation. May be async;
 * Strata awaits it before the route handler settles.
 */
export type StrataAnalogCleanup = () => void | Promise<void>;

/** No outcome yet, a successful one, or the error the invocation failed with. */
type Outcome = { readonly failed: false } | { readonly failed: true; readonly error: unknown };

/**
 * The cleanup callbacks registered during one controller invocation. Internal:
 * the public surface is only `onCleanup` on the factory context.
 */
export class CleanupScope {
  readonly #cleanups: StrataAnalogCleanup[] = [];
  #closed = false;

  /** Stable, `this`-free function, so it survives destructuring (`{ onCleanup }`). */
  readonly register = (cleanup: StrataAnalogCleanup): void => {
    if (typeof cleanup !== "function") {
      throw new StrataAnalogConfigurationError("onCleanup() expects a function.");
    }

    if (this.#closed) {
      throw new StrataAnalogConfigurationError(
        "onCleanup() was called after the controller invocation finished; register cleanups " +
          "before the controllerFactory or handler settles.",
      );
    }

    this.#cleanups.push(cleanup);
  };

  /**
   * Runs every registered cleanup exactly once, last registered first,
   * awaiting each one, then settles the invocation:
   *
   * - no errors: returns `result`;
   * - only the invocation failed: rethrows its error unchanged;
   * - only one cleanup failed: throws that cleanup error;
   * - otherwise: throws an `AggregateError` with the invocation error (if any)
   *   followed by every cleanup error, in the order the cleanups ran.
   */
  async close<T>(outcome: Outcome, result?: T): Promise<T | undefined> {
    this.#closed = true;

    const errors: unknown[] = [];

    for (let cleanup = this.#cleanups.pop(); cleanup; cleanup = this.#cleanups.pop()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 0) {
      if (outcome.failed) {
        throw outcome.error;
      }

      return result;
    }

    if (!outcome.failed && errors.length === 1) {
      throw errors[0];
    }

    throw new AggregateError(
      outcome.failed ? [outcome.error, ...errors] : errors,
      outcome.failed
        ? `A Strata controller invocation failed and ${String(errors.length)} cleanup callback(s) also failed.`
        : `${String(errors.length)} Strata cleanup callbacks failed.`,
    );
  }
}
