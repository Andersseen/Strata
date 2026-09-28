import {
  ApplicationRef,
  DestroyRef,
  Directive,
  ElementRef,
  EnvironmentInjector,
  InjectionToken,
  Injector,
  afterNextRender,
  createComponent,
  inject,
  reflectComponentType,
} from "@angular/core";
import type { ComponentRef, Provider, Type } from "@angular/core";

/** The interactive components a server component may render, by selector. */
const CLIENT_REFERENCES = new InjectionToken<readonly Type<unknown>[]>("STRATA_CLIENT_REFERENCES");

export function provideClientReferences(references: readonly Type<unknown>[]): Provider {
  return { provide: CLIENT_REFERENCES, useValue: references };
}

/**
 * Browser side of a server component. Hosted by the generated surrogate,
 * whose own template is empty: the server-rendered subtree is left in place
 * and never re-rendered. Each client boundary inside it (marked on the
 * server by StrataClientBoundary) is hydrated as its own Angular root,
 * attached to the application, from the hydration annotation (`ngh`) the
 * server already wrote on its host element.
 */
@Directive()
export class StrataIslandHost {
  constructor() {
    const host = inject(ElementRef).nativeElement as HTMLElement;
    const references = new Map(
      inject(CLIENT_REFERENCES).map((type) => [reflectComponentType(type)?.selector, type]),
    );
    const appRef = inject(ApplicationRef);
    const environmentInjector = inject(EnvironmentInjector);
    const elementInjector = inject(Injector);
    const islands: ComponentRef<unknown>[] = [];

    afterNextRender(() => {
      for (const hostElement of host.querySelectorAll<HTMLElement>("[data-strata-client]")) {
        // A boundary nested in another client component belongs to that component.
        const outer = hostElement.parentElement?.closest("[data-strata-client]");

        if (outer && host.contains(outer)) continue;

        const selector = hostElement.getAttribute("data-strata-client") ?? "";
        const type = references.get(selector);

        if (!type) {
          throw new Error(`[strata] No client reference for <${selector}> in <${host.localName}>.`);
        }

        const island = createComponent(type, { environmentInjector, elementInjector, hostElement });
        const props = JSON.parse(hostElement.getAttribute("data-strata-props") ?? "{}") as Record<
          string,
          unknown
        >;

        for (const [name, value] of Object.entries(props)) island.setInput(name, value);

        appRef.attachView(island.hostView);
        islands.push(island);
        hostElement.setAttribute("data-strata-hydrated", "");
      }
    });

    inject(DestroyRef).onDestroy(() => islands.forEach((island) => island.destroy()));
  }
}
