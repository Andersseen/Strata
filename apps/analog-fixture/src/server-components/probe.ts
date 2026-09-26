import { isPlatformBrowser } from "@angular/common";
import { PLATFORM_ID, inject, provideEnvironmentInitializer } from "@angular/core";
import type { EnvironmentProviders } from "@angular/core";
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
