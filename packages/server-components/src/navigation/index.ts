import { DOCUMENT, Location, isPlatformBrowser } from "@angular/common";
import { inject, PLATFORM_ID } from "@angular/core";
import type { CanActivateFn } from "@angular/router";
import { Router, UrlSerializer } from "@angular/router";

import { StrataDocumentNavigator } from "./navigator.js";
import { documentUrlForRouterUrl } from "./resolve.js";

export { StrataDocumentLink } from "./link.js";
export { StrataDocumentNavigator } from "./navigator.js";
export type { StrataDocumentNavigateOptions } from "./navigator.js";
export { StrataDocumentNavigationError } from "./resolve.js";
export type { StrataDocumentDestination, StrataDocumentNavigationExtras } from "./resolve.js";

/**
 * Opt-in guard for routes whose rendered subtree is server-owned.
 *
 * SSR and the browser's initial navigation render and hydrate normally. Any
 * later Angular Router activation is cancelled before the route component is
 * created and retried as a same-origin document navigation (base href, query
 * and fragment preserved), because a client-side activation only has the
 * generated empty surrogate. A navigation to the current URL is cancelled
 * without a request, so the guard cannot cause a reload loop.
 */
export const strataDocumentNavigationGuard: CanActivateFn = (_route, state) => {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;

  const router = inject(Router);

  if (!router.navigated) return true;

  const documentNavigator = inject(StrataDocumentNavigator);

  try {
    documentNavigator.go(
      documentUrlForRouterUrl(
        {
          router,
          location: inject(Location),
          serializer: inject(UrlSerializer),
          origin: inject(DOCUMENT).location?.origin,
        },
        state.url,
      ),
    );
  } catch {
    // Unsafe or cross-origin target: fail closed, no activation, no request.
  }

  return false;
};
