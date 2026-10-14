import { DOCUMENT, isPlatformBrowser } from "@angular/common";
import { inject, PLATFORM_ID } from "@angular/core";
import type { CanActivateFn } from "@angular/router";
import { Router } from "@angular/router";

/**
 * Experimental opt-in fallback for routes whose rendered subtree is server-owned.
 *
 * SSR and the browser's initial navigation are allowed to render and hydrate
 * normally. Later Angular Router activations are cancelled and retried as a
 * same-origin document navigation because a client-side route activation only
 * has the generated empty surrogate available.
 */
export const strataDocumentNavigationGuard: CanActivateFn = (_route, state) => {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;

  const router = inject(Router);
  const document = inject(DOCUMENT);

  if (!router.navigated) return true;

  const currentLocation = document.defaultView?.location;
  if (!currentLocation) return false;

  const target = new URL(state.url, currentLocation.href);
  if (target.origin !== currentLocation.origin) return false;

  currentLocation.assign(`${target.pathname}${target.search}${target.hash}`);
  return false;
};
