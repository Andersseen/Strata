import type { CleanupScope } from "./cleanup-scope.js";
import { StrataAnalogConfigurationError } from "./errors.js";

/** What a streamed body may yield: text (UTF-8 encoded) or raw bytes. */
export type StrataAnalogStreamChunk = string | Uint8Array;

/** An async source of response chunks, typically an `async function*` generator. */
export type StrataAnalogStreamBody = AsyncIterable<StrataAnalogStreamChunk>;

/**
 * Ownership of one streamed response: unclaimed until the route handler has
 * seen the final result of the invocation, then bound to that invocation's
 * `CleanupScope` until the body reaches a terminal outcome.
 */
class StreamOwnership {
  #scope: CleanupScope | undefined;
  #claimed = false;
  #abandoned = false;
  #release: Promise<void> | undefined;

  get claimed(): boolean {
    return this.#claimed;
  }

  /**
   * Binds the scope to this stream. Returns false, leaving the scope with the
   * caller, when the consumer cancelled the stream before it was claimed.
   */
  claim(scope: CleanupScope): boolean {
    if (this.#abandoned) return false;
    if (this.#claimed) {
      throw new StrataAnalogConfigurationError(
        "A streamResponse() response can be returned from one controller invocation only.",
      );
    }
    this.#claimed = true;
    this.#scope = scope;
    return true;
  }

  /**
   * Closes the scope once, whichever terminal outcome reaches it first; later
   * outcomes observe the same settlement instead of closing again. Rejects with
   * what `CleanupScope.close` throws: the stream error when every cleanup
   * succeeded, otherwise the cleanup error(s).
   */
  release(failure: { readonly error: unknown } | undefined): Promise<void> {
    if (!this.#claimed) {
      this.#abandoned = true;
      return Promise.resolve();
    }
    this.#release ??= this.#close(failure);
    return this.#release;
  }

  async #close(failure: { readonly error: unknown } | undefined): Promise<void> {
    await this.#scope?.close(failure ? { failed: true, error: failure.error } : { failed: false });
  }
}

const ownerships = new WeakMap<Response, StreamOwnership>();

/**
 * A native `Response` whose body is produced incrementally from `body`, and
 * whose request-scoped resources (everything registered with `onCleanup`) stay
 * open until that body ends instead of closing when the handler returns.
 *
 * Return it from a controller handler, directly or through interceptors that
 * pass the same object on. The adapter then holds the invocation's cleanup
 * scope until the first of:
 *
 * - the body completes, or
 * - `body` throws, or
 * - the consumer cancels the body (`response.body.cancel()`, or the transport
 *   cancelling its reader).
 *
 * Cleanups then run once, last registered first, awaited, and a cleanup failure
 * fails the stream. The body is pulled lazily and never read ahead, and it
 * stays unconsumed until the adapter owns it; reading it earlier fails the
 * stream.
 *
 * Release depends on the transport reading the body to its end or cancelling
 * it. Strata does not observe client disconnects: use a finite `body`.
 */
export function streamResponse(body: StrataAnalogStreamBody, init: ResponseInit = {}): Response {
  if (body === null || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw new StrataAnalogConfigurationError("streamResponse() expects an async iterable body.");
  }

  const ownership = new StreamOwnership();
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<StrataAnalogStreamChunk> | undefined;
  let ended = false;

  // Stops the producer, then releases the scope. `failure` is set when the
  // stream, not the consumer, ended it.
  const end = async (failure?: { readonly error: unknown }): Promise<void> => {
    ended = true;
    try {
      await iterator?.return?.();
    } catch (error) {
      failure ??= { error };
    }
    await ownership.release(failure);
  };

  const source = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (ended) return;
        if (!ownership.claimed) {
          ended = true;
          controller.error(
            new StrataAnalogConfigurationError(
              "A streamResponse() body was read before the controller invocation returned it, " +
                "or its response was replaced; it can only be consumed as the returned response.",
            ),
          );
          return;
        }

        // The stream, not the consumer, ended: stop the producer, release, then error it.
        const fail = async (error: unknown): Promise<void> => {
          try {
            await end({ error });
            controller.error(error);
          } catch (settled) {
            controller.error(settled);
          }
        };

        let step: IteratorResult<StrataAnalogStreamChunk>;
        try {
          iterator ??= body[Symbol.asyncIterator]();
          step = await iterator.next();
        } catch (error) {
          if (ended) return;
          iterator = undefined; // it threw: there is nothing left to return()
          await fail(error);
          return;
        }
        if (ended) return;

        if (step.done === true) {
          iterator = undefined;
          try {
            await end();
          } catch (settled) {
            controller.error(settled);
            return;
          }
          controller.close();
          return;
        }

        const chunk = step.value;
        if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
          await fail(
            new TypeError("A streamResponse() body may only yield strings or Uint8Array."),
          );
          return;
        }

        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      },
      async cancel() {
        if (ended) return;
        await end();
      },
    },
    { highWaterMark: 0 },
  );

  const response = new Response(source, init);
  ownerships.set(response, ownership);
  return response;
}

/**
 * Hands the invocation's cleanup scope to `result` when it is an unclaimed,
 * not yet cancelled `streamResponse()` response. Returns whether it did, so the
 * caller must not close the scope itself.
 */
export function claimStreamResponse(result: unknown, scope: CleanupScope): boolean {
  if (!(result instanceof Response)) return false;
  const ownership = ownerships.get(result);
  if (!ownership) return false;
  return ownership.claim(scope);
}
