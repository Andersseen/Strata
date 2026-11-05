import { ErrorHandler, inject } from "@angular/core";
import type { Provider, ProviderToken } from "@angular/core";

/**
 * CONSUMER-OWNED recipe of the buffered SSR failure contract, for published
 * `@strata-sc/server-components` versions that predate the `/ssr` entry (< 0.15.0).
 *
 * The packed qualification never uses this file: it imports `@strata-sc/server-components/ssr` from
 * the installed tarball. Only the registry and frozen-candidate modes, which install a published
 * tuple without that entry, copy it to `src/ssr-failure-contract.ts` and point the fixture's two
 * imports at it (tools/server-components/lib/ssr-recipe-bridge.ts). It is the PR #172 pattern with the
 * same exported names and behaviour as the package entry, so the same checks apply to both.
 * Remove it once the frozen candidate and every A/B pair carry the `/ssr` entry.
 */
export interface StrataSsrResponse {
  statusCode: number;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  getHeaderNames?(): string[];
  getHeader?(name: string): unknown;
  removeHeader?(name: string): unknown;
}

export type StrataSsrRender<Context extends { readonly res: StrataSsrResponse }> = (
  url: string,
  document: string,
  context: Context,
) => Promise<string>;

export const STRATA_SSR_FAILURE_DOCUMENT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page unavailable</title></head><body><main id="render-failure">This page could not be rendered.</main></body></html>';

const rendering = new WeakMap<object, unknown[]>();

class RecipeErrorHandler extends ErrorHandler {
  constructor(private readonly response: object | null) {
    super();
  }

  override handleError(error: unknown): void {
    const errors = this.response ? rendering.get(this.response) : undefined;
    if (!errors) return super.handleError(error);
    if (!errors.includes(error)) errors.push(error);
  }
}

export function provideStrataSsrFailureHandler<Response extends object>(
  response: ProviderToken<Response>,
): Provider[] {
  return [
    {
      provide: ErrorHandler,
      useFactory: () => new RecipeErrorHandler(inject(response, { optional: true })),
    },
  ];
}

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name || "Error" : typeof error;

export function withStrataSsrFailureContract<Context extends { readonly res: StrataSsrResponse }>(
  render: StrataSsrRender<Context>,
): StrataSsrRender<Context> {
  return async (url, document, context) => {
    const response = context.res;
    const errors: unknown[] = [];
    const before =
      response.getHeaderNames && response.getHeader
        ? new Map(response.getHeaderNames().map((name) => [name, response.getHeader!(name)]))
        : undefined;
    let html: string | undefined;
    let phase = "render";

    rendering.set(response, errors);
    try {
      html = await render(url, document, context);
    } catch (error) {
      phase = "rejection";
      if (!errors.includes(error)) errors.push(error);
    } finally {
      rendering.delete(response);
    }
    if (html !== undefined && errors.length === 0) return html;

    if (before && response.removeHeader) {
      for (const name of response.getHeaderNames!())
        if (!before.has(name)) response.removeHeader(name);
      for (const [name, value] of before)
        if (response.getHeader!(name) !== value && value !== undefined)
          response.setHeader(name, value as string);
    }
    response.statusCode = 500;
    response.setHeader("cache-control", "no-store");
    console.error(
      `[strata:ssr] unexpected render failure (${[...new Set(errors.map(nameOf))].join(", ")}; ${phase}); answered HTTP 500`,
    );
    return STRATA_SSR_FAILURE_DOCUMENT;
  };
}
