import { DOCUMENT, isPlatformBrowser, Location } from "@angular/common";
import { inject, Injectable, PLATFORM_ID } from "@angular/core";
import { Router, UrlSerializer } from "@angular/router";

import { StrataDocumentNavigationError, resolveDocumentUrl } from "./resolve.js";
import type { StrataDocumentDestination, StrataDocumentNavigationExtras } from "./resolve.js";

export interface StrataDocumentNavigateOptions extends StrataDocumentNavigationExtras {
  /** Replace the current history entry instead of adding one. */
  readonly replace?: boolean;
}

/**
 * Programmatic, intentional full-document navigation to a Server Component
 * route. It never calls `Router.navigate()`: the browser requests a new HTML
 * document and Angular bootstraps and hydrates it.
 *
 * Outside a browser (SSR) `navigate()` does nothing and returns `false`;
 * `resolve()` works everywhere.
 */
@Injectable({ providedIn: "root" })
export class StrataDocumentNavigator {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly serializer = inject(UrlSerializer);
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly context = {
    router: this.router,
    location: this.location,
    serializer: this.serializer,
    origin: this.document.location?.origin,
  };
  private pending: string | null = null;

  /** The document URL (root-relative, with base href, query and fragment) for a destination. */
  resolve(
    destination: StrataDocumentDestination,
    extras: StrataDocumentNavigationExtras = {},
  ): string {
    return resolveDocumentUrl(this.context, destination, extras);
  }

  /**
   * Requests a document navigation. Returns `true` when one was started and
   * `false` when nothing was started: not in a browser, the destination is the
   * current URL, or the same navigation is already in flight.
   * @throws StrataDocumentNavigationError for an invalid, unsafe or cross-origin destination.
   */
  navigate(
    destination: StrataDocumentDestination,
    options: StrataDocumentNavigateOptions = {},
  ): boolean {
    const href = this.resolve(destination, options);

    return this.go(href, options.replace === true);
  }

  /** @internal Used by the route guard, which already holds a router URL. */
  go(href: string, replace = false): boolean {
    if (!this.browser) return false;

    const current = this.document.defaultView?.location;
    if (!current) return false;

    const target = new URL(href, current.href);
    if (target.origin !== current.origin) {
      throw new StrataDocumentNavigationError("refusing a cross-origin document navigation.");
    }

    const next = `${target.pathname}${target.search}${target.hash}`;
    if (next === `${current.pathname}${current.search}${current.hash}` || next === this.pending) {
      return false;
    }

    this.pending = next;
    if (replace) current.replace(next);
    else current.assign(next);

    return true;
  }
}
