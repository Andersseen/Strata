import { isPlatformBrowser } from "@angular/common";
import { ApplicationRef, PLATFORM_ID, inject, provideEnvironmentInitializer } from "@angular/core";
import type { EmbeddedViewRef, EnvironmentProviders } from "@angular/core";
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
} from "@angular/router";

/**
 * Fixture-only evidence for `pnpm test:server-component-navigation`
 * (docs/research/server-component-navigation-poc.md): the router events of
 * the current document, as `<event> <url>`, on a window global the Playwright
 * runner reads. Nothing in the app reads it. Does nothing during SSR.
 * Not public API.
 */
export function provideNavigationProbe(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;

    const scope = globalThis as { __STRATA_ROUTER_PROBE__?: string[] };
    const events = (scope.__STRATA_ROUTER_PROBE__ ??= []);

    inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationStart) events.push(`start ${event.url}`);
      else if (event instanceof NavigationEnd) events.push(`end ${event.urlAfterRedirects}`);
      else if (event instanceof NavigationCancel) events.push(`cancel ${event.url}`);
      else if (event instanceof NavigationError) events.push(`error ${event.url}`);
    });
  });
}

/**
 * Fixture-only evidence for the server-component runners: island ComponentRefs
 * created and destroyed in this document, as `window.__STRATA_ISLAND_PROBE__`.
 * `StrataIslandHost` (@strata-sc/server-components) attaches each island's
 * host view to the ApplicationRef; this wraps that instance's `attachView` to
 * count the views whose host is a client boundary, and when each is destroyed.
 * The package itself writes no globals. Does nothing during SSR. Not public API.
 */
export function provideIslandProbe(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;

    const scope = globalThis as {
      __STRATA_ISLAND_PROBE__?: { created: number; destroyed: number };
    };
    const islands = (scope.__STRATA_ISLAND_PROBE__ ??= { created: 0, destroyed: 0 });
    const appRef = inject(ApplicationRef);
    const attachView = appRef.attachView.bind(appRef);

    appRef.attachView = (view) => {
      attachView(view);

      const host = (view as EmbeddedViewRef<unknown>).rootNodes[0] as Element | undefined;

      if (host?.hasAttribute?.("data-strata-client")) {
        islands.created++;
        view.onDestroy(() => islands.destroyed++);
      }
    };
  });
}
