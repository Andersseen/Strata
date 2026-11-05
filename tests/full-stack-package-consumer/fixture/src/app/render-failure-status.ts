import { ErrorHandler, Injectable, inject } from "@angular/core";
import type { Provider } from "@angular/core";
import { RESPONSE } from "@analogjs/router/tokens";
import type { ServerContext } from "@analogjs/router/tokens";

/**
 * Application-owned SSR failure contract (docs/research/pre1-runtime-hardening.md, Workstream C).
 *
 * Angular buffers a server render: `renderApplication` resolves with the whole document before
 * Analog writes a byte. Every unexpected render error (component construction, an injected service,
 * a template binding, a Strata boundary refusal) is reported to the application's `ErrorHandler`
 * before that promise resolves, yet the HTML still resolves and Analog answers HTTP 200 with an
 * empty or half-rendered document.
 *
 * This file closes that gap with public APIs only:
 *  - Angular's `ErrorHandler` (the documented customization point, provided at application level);
 *  - Analog's public `RESPONSE` token (the per-request response object);
 *  - the function `render()` from `@analogjs/router/server` returns, which the application's own
 *    `main.server.ts` exports.
 * A failed render is marked on ITS response object; the wrapper sees the mark after the buffered
 * render and, before anything is committed, replaces the incomplete document with a generic 500
 * page. The server log gets one redacted line per failure (class name only); no error text reaches
 * the client or the log.
 */
const failedResponses = new WeakSet<object>();

@Injectable()
export class RenderFailureErrorHandler extends ErrorHandler {
  private readonly response = inject(RESPONSE, { optional: true });

  override handleError(error: unknown): void {
    if (this.response) failedResponses.add(this.response);
    // Redacted: an error message may carry request or tenant data, and server logs are a public
    // surface for this fixture's log-redaction checks. Name the failure class only.
    console.error(
      `[render-failure] ${error instanceof Error ? error.name : typeof error} during server render`,
    );
  }
}

export const provideRenderFailureStatus = (): Provider[] => [
  { provide: ErrorHandler, useClass: RenderFailureErrorHandler },
];

/** Generic, cache-safe and hydration-free: no application markup, no Strata boundary, no error text. */
export const RENDER_FAILURE_DOCUMENT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page unavailable</title></head><body><main id="render-failure">This page could not be rendered.</main></body></html>';

type AnalogRender = (url: string, document: string, context: ServerContext) => Promise<string>;

export function withRenderFailureStatus(render: AnalogRender): AnalogRender {
  return async (url, document, context) => {
    let html: string | undefined;
    try {
      html = await render(url, document, context);
    } catch (error) {
      // Bootstrap or initializer failures reject before any document exists.
      failedResponses.add(context.res);
      console.error(
        `[render-failure] ${error instanceof Error ? error.name : typeof error} during server render`,
      );
    }
    if (html === undefined || failedResponses.has(context.res)) {
      failedResponses.delete(context.res);
      context.res.statusCode = 500;
      context.res.setHeader("cache-control", "no-store");
      return RENDER_FAILURE_DOCUMENT;
    }
    return html;
  };
}
