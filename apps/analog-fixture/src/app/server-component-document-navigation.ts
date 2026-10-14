import { isPlatformBrowser } from "@angular/common";
import { DOCUMENT } from "@angular/common";
import { inject, PLATFORM_ID } from "@angular/core";
import type { CanActivateFn } from "@angular/router";
import { Router } from "@angular/router";

/**
 * Fixture-only policy for a route whose implementation is server-owned.
 *
 * The initial SSR/bootstrap navigation is allowed. Once the browser router
 * has completed that initial navigation, a client transition is cancelled
 * before activation and retried as a document request. This deliberately
 * does not attempt to hydrate a newly fetched subtree in the current realm.
 */
export const serverComponentDocumentNavigation: CanActivateFn = (_route, state) => {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;

  const router = inject(Router);
  const document = inject(DOCUMENT);

  // The control mode keeps the historical empty-surrogate characterization
  // available without weakening the normal, explicitly protected route.
  if (state.root.queryParams["strataNavigationControl"] === "1") return true;

  if (!router.navigated) return true;

  document.defaultView?.location.assign(state.url);
  return false;
};
