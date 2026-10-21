import type { Location } from "@angular/common";
import type { ActivatedRoute, Params, Router, UrlSerializer, UrlTree } from "@angular/router";

/** A same-origin Angular route destination: a root-relative URL, a `UrlTree` or route commands. */
export type StrataDocumentDestination = string | UrlTree | readonly unknown[];

export interface StrataDocumentNavigationExtras {
  /** Query parameters for a command-array destination. */
  readonly queryParams?: Params | null | undefined;
  /** Fragment for a command-array destination, without the leading `#`. */
  readonly fragment?: string | null | undefined;
  /** Route that relative commands resolve against. Defaults to the root. */
  readonly relativeTo?: ActivatedRoute | null | undefined;
}

/** What URL resolution needs from the application's injector. */
export interface DocumentUrlContext {
  readonly router: Router;
  readonly location: Location;
  readonly serializer: UrlSerializer;
  /**
   * Origin of the current document (the request origin during SSR). Angular's
   * `PathLocationStrategy` falls back to it as the base href when the page has
   * no `<base>`, so a same-origin prefix is stripped; any other origin is rejected.
   */
  readonly origin?: string | null | undefined;
}

/** Raised for a destination that cannot be turned into a same-origin document URL. */
export class StrataDocumentNavigationError extends Error {
  constructor(message: string) {
    super(`[strata] ${message}`);
    this.name = "StrataDocumentNavigationError";
  }
}

// Scheme-like prefix ("javascript:", "data:", "https:"); a segment containing ":" after a "/" is fine.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\\]/;

/**
 * Resolves a destination to a root-relative document URL, including the
 * application's base href. Uses Angular's own `createUrlTree`, `parseUrl` and
 * `serializeUrl`, so encoding and base href follow the application's router
 * configuration. Query parameters are never included in error messages.
 */
export function resolveDocumentUrl(
  context: DocumentUrlContext,
  destination: StrataDocumentDestination,
  extras: StrataDocumentNavigationExtras = {},
): string {
  const internal = serializeDestination(context, destination, extras);

  return assertSameOriginPath(
    stripOwnOrigin(context.location.prepareExternalUrl(internal), context.origin),
  );
}

/** Turns an Angular-router URL (`state.url`) into a document URL, including the base href. */
export function documentUrlForRouterUrl(context: DocumentUrlContext, routerUrl: string): string {
  return resolveDocumentUrl(context, routerUrl);
}

function serializeDestination(
  { router, serializer }: DocumentUrlContext,
  destination: StrataDocumentDestination,
  extras: StrataDocumentNavigationExtras,
): string {
  if (typeof destination === "string") {
    if (extras.queryParams || extras.fragment) {
      throw new StrataDocumentNavigationError(
        "queryParams and fragment cannot be combined with a string destination; put them in the string or pass route commands.",
      );
    }
    if (
      !destination.startsWith("/") ||
      destination.startsWith("//") ||
      SCHEME.test(destination) ||
      CONTROL.test(destination)
    ) {
      throw new StrataDocumentNavigationError(
        "a string destination must be a root-relative application URL such as '/products/42'; use a plain <a href> for external or non-root-relative URLs.",
      );
    }
    try {
      // `Router.parseUrl` swallows a malformed URL into "/"; the serializer throws.
      return router.serializeUrl(serializer.parse(destination));
    } catch {
      throw new StrataDocumentNavigationError("the destination string is not a valid route URL.");
    }
  }

  if (Array.isArray(destination)) {
    for (const command of destination) {
      if (typeof command === "string" && (SCHEME.test(command) || CONTROL.test(command))) {
        throw new StrataDocumentNavigationError(
          "route commands must not contain a URL scheme or control characters.",
        );
      }
    }
    try {
      return router.serializeUrl(
        router.createUrlTree(destination as unknown[], {
          relativeTo: extras.relativeTo ?? null,
          queryParams: extras.queryParams ?? null,
          ...(extras.fragment ? { fragment: extras.fragment } : {}),
        }),
      );
    } catch {
      throw new StrataDocumentNavigationError("the route commands are not valid.");
    }
  }

  if (destination && typeof destination === "object" && "root" in destination) {
    return router.serializeUrl(destination);
  }

  throw new StrataDocumentNavigationError(
    "the destination must be a root-relative string, a UrlTree or an array of route commands.",
  );
}

function stripOwnOrigin(href: string, origin: string | null | undefined): string {
  if (origin && href.startsWith(origin) && /^[/?#]|^$/.test(href.slice(origin.length))) {
    return href.slice(origin.length) || "/";
  }

  return href;
}

function assertSameOriginPath(href: string): string {
  // A base href may legitimately be a path; an absolute or protocol-relative
  // base would make the destination cross-origin, which this API never allows.
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) {
    throw new StrataDocumentNavigationError(
      "the resolved URL is not a same-origin path; check APP_BASE_HREF / <base href>.",
    );
  }

  return href;
}
