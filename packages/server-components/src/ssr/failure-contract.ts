import {
  ErrorHandler,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from "@angular/core";
import type { EnvironmentProviders, ProviderToken } from "@angular/core";

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
 * Analog or Nitro. Failure state lives ON that object, in a non-enumerable slot that exists only while
 * the wrapper is rendering it and is removed before the wrapper returns: one request cannot observe or
 * clear another request's failure, and this module holds no state at all.
 *
 * The slot's key comes from the global symbol registry, so two independently loaded copies of this
 * package meet on the same request (docs/research/rc0-production-qualification.md, "SSR installation
 * integrity"). Only the name is shared; the value belongs to one request. A module-level store split
 * in two there: each half missed the other and a failed render answered HTTP 200. The halves also
 * prove they met. Angular creates `ErrorHandler` lazily, on the first error, so a healthy render
 * would never reveal a missing handler; an environment initializer connects it on every render, and
 * either half refuses a render the other is not part of.
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
export type StrataSsrFailurePhase = "render" | "rejection" | "integration";

/**
 * One failed request, reported once. `errorNames` is safe for any log. `errors` holds the original
 * values: they may carry request, tenant or credential data and must never reach a client, a URL or a
 * shared log without the application's own redaction.
 */
export interface StrataSsrFailure {
  /**
   * `"rejection"` when the render promise rejected (bootstrap or initializer), `"integration"` when
   * the render finished but no compatible failure handler took part in it, otherwise `"render"`.
   */
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

/** The registry name of the per-request slot. Changing its value shape requires a new `PROTOCOL`. */
const CONTRACT = Symbol.for("@strata-sc/server-components:ssr-failure-contract");
const PROTOCOL = 1;

/** What one render offers the handler, on that render's response object. */
interface RenderContract {
  readonly protocol: number;
  /** The handler is part of this render. */
  connect(): void;
  /** Marks the render failed; `false` once the wrapper has chosen the response. */
  record(error: unknown): boolean;
}

const contractSlot = (response: object): unknown => Reflect.get(response, CONTRACT);

function contractOf(response: object): RenderContract | undefined {
  const contract = contractSlot(response) as RenderContract | undefined;

  return contract?.protocol === PROTOCOL ? contract : undefined;
}

/** Names the broken composition. Carries no request data. */
function integrationError(message: string): Error {
  const error = new Error(`[strata:ssr] ${message}`);
  error.name = "StrataSsrIntegrationError";

  return error;
}

class StrataSsrFailureErrorHandler extends ErrorHandler {
  constructor(private readonly response: object | null) {
    super();
  }

  override handleError(error: unknown): void {
    // Outside a wrapped render (browser, or a late error after the response was chosen) Angular's
    // native behaviour is kept.
    if (this.response && contractOf(this.response)?.record(error)) return;
    super.handleError(error);
  }
}

/**
 * Server-only: makes this application's `ErrorHandler` mark the CURRENT request as failed while
 * {@link withStrataSsrFailureContract} renders it. Pass the host's public per-request response
 * token, for Analog `RESPONSE` from `@analogjs/router/tokens`. Register it in the server
 * application config only; it replaces any other application `ErrorHandler`.
 *
 * A render with a response but no compatible wrapper is refused: it could only answer HTTP 200 for
 * a failed page. Without a response (a browser bootstrap) the provider does nothing.
 */
export function provideStrataSsrFailureHandler<Response extends object>(
  response: ProviderToken<Response>,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: ErrorHandler,
      useFactory: () => new StrataSsrFailureErrorHandler(inject(response, { optional: true })),
    },
    provideEnvironmentInitializer(() => {
      const current = inject(response, { optional: true });

      if (!current) return;

      const contract = contractOf(current);

      if (!contract) {
        throw integrationError(
          "provideStrataSsrFailureHandler() is rendering outside a compatible withStrataSsrFailureContract(): wrap the server render, and install one version of @strata-sc/server-components.",
        );
      }
      contract.connect();
    }),
  ]);
}

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name || "Error" : typeof error;

const defaultReport = ({ errorNames, errors, phase }: StrataSsrFailure): void => {
  if (phase === "integration") {
    console.error((errors[0] as Error).message);
    return;
  }
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
 * A render that finishes without a connected {@link provideStrataSsrFailureHandler} is answered the
 * same way, however healthy it looks: the provider is missing, was given the wrong token, or comes
 * from an incompatible copy of this package, so nothing could have reported a failure. Every
 * request failing loudly is the intended result of that misconfiguration; the alternative is a
 * production HTTP 200 for a broken page. The inner render therefore must be a real Angular render,
 * not a cache of finished documents.
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
    const outer = contractSlot(response);

    if (outer !== undefined) {
      // Wrapped twice: the outer wrapper already owns this render's outcome.
      if (contractOf(response)) return render(url, document, context);
      throw integrationError(
        "two incompatible versions of @strata-sc/server-components wrap this render.",
      );
    }

    const errors: unknown[] = [];
    const headers = snapshotHeaders(response);
    let html: string | undefined;
    let phase: StrataSsrFailurePhase = "render";
    let connected = false;
    let open = true;

    Object.defineProperty(response, CONTRACT, {
      configurable: true,
      value: Object.freeze({
        protocol: PROTOCOL,
        connect: () => {
          connected = true;
        },
        record: (error: unknown) => {
          if (!open) return false;
          if (!errors.includes(error)) errors.push(error);
          return true;
        },
      } satisfies RenderContract),
    });
    try {
      html = await render(url, document, context);
    } catch (error) {
      phase = "rejection";
      if (!errors.includes(error)) errors.push(error);
    } finally {
      // The request's failure state never outlives its own render.
      open = false;
      Reflect.deleteProperty(response, CONTRACT);
    }

    if (errors.length === 0 && !connected) {
      phase = "integration";
      errors.push(
        integrationError(
          "no compatible provideStrataSsrFailureHandler() took part in this render, so its outcome is unknown: register it with the host's response token in the server config, and install one version of @strata-sc/server-components. Answered HTTP 500.",
        ),
      );
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
