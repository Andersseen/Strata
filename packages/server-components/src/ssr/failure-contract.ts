import { ErrorHandler, inject } from "@angular/core";
import type { Provider, ProviderToken } from "@angular/core";

/**
 * The opt-in, buffered SSR failure contract (docs/research/ssr-failure-contract.md).
 *
 * Angular buffers a server render: `renderApplication` resolves with the whole document before the
 * host framework writes a byte. An unexpected render error (a component constructor, an injected
 * service, a template binding, a Strata boundary refusal) is reported to the application's
 * `ErrorHandler`, yet the document still resolves and Analog answers HTTP 200 with an empty or
 * half-rendered page. This entry closes that gap with two public seams only:
 *
 *  - an application-level Angular `ErrorHandler` that records a failure on ITS request's response
 *    object (read through the host framework's own public token, passed in by the application);
 *  - a wrapper around the host's buffered `render(url, document, context)` function that, after the
 *    render settles and before anything is committed, replaces a failed document with a generic
 *    HTTP 500 page.
 *
 * The response object identity is the only link between the two, so the entry imports nothing from
 * Analog or Nitro. Failure state lives in a `WeakMap` keyed by that object, exists only while the
 * wrapper is rendering it and is removed before the wrapper returns: one request cannot observe or
 * clear another request's failure.
 */

/** The response surface the contract needs. Node's `ServerResponse` and Analog's `RESPONSE` satisfy it. */
export interface StrataSsrResponse {
  statusCode: number;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  getHeaderNames?(): string[];
  getHeader?(name: string): unknown;
  removeHeader?(name: string): unknown;
}

/** The buffered render function Analog's `render()` (and compatible hosts) return. */
export type StrataSsrRender<Context extends { readonly res: StrataSsrResponse }> = (
  url: string,
  document: string,
  context: Context,
) => Promise<string>;

/** Where the contract saw the failure. */
export type StrataSsrFailurePhase = "render" | "rejection";

/**
 * One failed request, reported once. `errorNames` is safe for any log. `errors` holds the original
 * values: they may carry request, tenant or credential data and must never reach a client, a URL or a
 * shared log without the application's own redaction.
 */
export interface StrataSsrFailure {
  /** `"rejection"` when the render promise rejected (bootstrap or initializer), otherwise `"render"`. */
  readonly phase: StrataSsrFailurePhase;
  /** The error class names (`error.name`) or `typeof` for non-errors, de-duplicated, in order. */
  readonly errorNames: readonly string[];
  /** The original error values, de-duplicated by identity, in order. Private. */
  readonly errors: readonly unknown[];
}

export interface StrataSsrFailureOptions {
  /**
   * Receives each failed request once, after the failure document is chosen. The default writes one
   * redacted line to `console.error` (class names only). A throwing reporter is ignored.
   */
  readonly report?: (failure: StrataSsrFailure) => void;
  /**
   * The static HTML answered with HTTP 500. It must not depend on the request; it is never cached
   * (`cache-control: no-store`). Defaults to {@link STRATA_SSR_FAILURE_DOCUMENT}.
   */
  readonly failureDocument?: string;
}

/** Generic, cache-safe and hydration-free: no application markup, no Strata boundary, no error text. */
export const STRATA_SSR_FAILURE_DOCUMENT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page unavailable</title></head><body><main id="render-failure">This page could not be rendered.</main></body></html>';

/** Recorded errors of a response the wrapper is currently rendering. */
const rendering = new WeakMap<object, unknown[]>();

function record(response: object, error: unknown): boolean {
  const errors = rendering.get(response);

  if (!errors) return false;
  if (!errors.includes(error)) errors.push(error);

  return true;
}

class StrataSsrFailureErrorHandler extends ErrorHandler {
  constructor(private readonly response: object | null) {
    super();
  }

  override handleError(error: unknown): void {
    // Outside a wrapped render (browser, a late error after the response was chosen, or a missing
    // wrapper) Angular's native behaviour is kept.
    if (this.response && record(this.response, error)) return;
    super.handleError(error);
  }
}

/**
 * Server-only: makes this application's `ErrorHandler` mark the CURRENT request as failed while
 * {@link withStrataSsrFailureContract} renders it. Pass the host's public per-request response
 * token, for Analog `RESPONSE` from `@analogjs/router/tokens`. Register it in the server
 * application config only; it replaces any other application `ErrorHandler`.
 */
export function provideStrataSsrFailureHandler<Response extends object>(
  response: ProviderToken<Response>,
): Provider[] {
  return [
    {
      provide: ErrorHandler,
      useFactory: () => new StrataSsrFailureErrorHandler(inject(response, { optional: true })),
    },
  ];
}

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name || "Error" : typeof error;

const defaultReport = ({ errorNames, phase }: StrataSsrFailure): void => {
  console.error(
    `[strata:ssr] unexpected render failure (${errorNames.join(", ")}; ${phase}); answered HTTP 500`,
  );
};

function snapshotHeaders(response: StrataSsrResponse): Map<string, unknown> | undefined {
  if (typeof response.getHeaderNames !== "function" || typeof response.getHeader !== "function")
    return undefined;

  return new Map(response.getHeaderNames().map((name) => [name, response.getHeader!(name)]));
}

/** Drops headers the failed render added and restores the ones it changed. */
function restoreHeaders(response: StrataSsrResponse, before: Map<string, unknown> | undefined) {
  if (!before || typeof response.removeHeader !== "function") return;

  for (const name of response.getHeaderNames!()) {
    if (!before.has(name)) response.removeHeader(name);
  }
  for (const [name, value] of before) {
    if (response.getHeader!(name) !== value && value !== undefined)
      response.setHeader(name, value as string | number | readonly string[]);
  }
}

/**
 * Wraps a buffered SSR `render` function: when the render rejects, or the application's
 * {@link provideStrataSsrFailureHandler} recorded an error for this request, the incomplete document
 * is discarded and the response becomes HTTP 500, `cache-control: no-store`, with a static failure
 * document. Headers the failed render set are removed. Healthy renders, and statuses the
 * application set itself (an application 404 page), pass through unchanged.
 *
 * Buffered rendering only: a streamed or already-committed response is not covered.
 */
export function withStrataSsrFailureContract<Context extends { readonly res: StrataSsrResponse }>(
  render: StrataSsrRender<Context>,
  options: StrataSsrFailureOptions = {},
): StrataSsrRender<Context> {
  const report = options.report ?? defaultReport;
  const failureDocument = options.failureDocument ?? STRATA_SSR_FAILURE_DOCUMENT;

  return async (url, document, context) => {
    const response = context.res;
    const errors: unknown[] = [];
    const headers = snapshotHeaders(response);
    let html: string | undefined;
    let phase: StrataSsrFailurePhase = "render";

    rendering.set(response, errors);
    try {
      html = await render(url, document, context);
    } catch (error) {
      phase = "rejection";
      if (!errors.includes(error)) errors.push(error);
    } finally {
      // The request's failure state never outlives its own render.
      rendering.delete(response);
    }

    if (html !== undefined && errors.length === 0) return html;

    restoreHeaders(response, headers);
    response.statusCode = 500;
    response.setHeader("cache-control", "no-store");
    try {
      report(
        Object.freeze({
          phase,
          errorNames: Object.freeze([...new Set(errors.map(nameOf))]),
          errors: Object.freeze([...errors]),
        }),
      );
    } catch {
      // Reporting is supplementary: the failure response stands.
    }

    return failureDocument;
  };
}
