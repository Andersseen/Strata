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

import { BOUNDARY_HYDRATED_ATTRIBUTE } from "./boundary-protocol.js";
import { BOUNDARY_HOST_SELECTOR, planClientBoundaries } from "./hydration-plan.js";
import type { ClientReference, PlannedClientBoundary } from "./hydration-plan.js";

/** The interactive components a server component may render, by selector. */
const CLIENT_REFERENCES = new InjectionToken<readonly Type<unknown>[]>("STRATA_CLIENT_REFERENCES");

export function provideClientReferences(references: readonly Type<unknown>[]): Provider {
  return { provide: CLIENT_REFERENCES, useValue: references };
}

function clientReferences(types: readonly Type<unknown>[]): Map<string, ClientReference> {
  return new Map(
    types.flatMap((type) => {
      const mirror = reflectComponentType(type);

      return mirror
        ? [
            [
              mirror.selector,
              {
                type,
                selector: mirror.selector,
                inputs: new Map(mirror.inputs.map((i) => [i.propName, i.templateName])),
              },
            ] as const,
          ]
        : [];
    }),
  );
}

/** Boundary hosts under `host`, in document order, minus those nested in another boundary. */
function discoverBoundaries(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(BOUNDARY_HOST_SELECTOR)].filter((element) => {
    // A boundary nested in another client component belongs to that component.
    const outer = element.parentElement?.closest(BOUNDARY_HOST_SELECTOR);

    return !outer || !host.contains(outer);
  });
}

/**
 * Browser side of a server component. Hosted by the generated surrogate,
 * whose own template is empty: the server-rendered subtree is left in place
 * and never re-rendered. Each client boundary inside it (marked on the
 * server by StrataClientBoundary) is hydrated as its own Angular root,
 * attached to the application, from the hydration annotation (`ngh`) the
 * server already wrote on its host element.
 *
 * Hydration is all-or-nothing per host: discover every boundary, validate
 * all of them (protocol, payload, selector, input names), then commit. A
 * failed preflight throws before any component exists; a commit failure
 * destroys the islands this commit created (restoring their inert SSR host
 * elements in place) before rethrowing. Either way the server-rendered DOM
 * stays, with no fallback, retry or reload.
 *
 * The throw is the report: Angular runs each `afterNextRender` callback in its
 * own try/catch, hands the error to the application's `ErrorHandler` exactly
 * once and does not rethrow, so a failing host is inert while its sibling
 * hosts (their own callbacks) still hydrate. Strata registers no ErrorHandler
 * of its own; pinned by `pnpm test:server-component-failures`
 * (docs/research/server-component-failure-recovery.md).
 */
@Directive()
export class StrataIslandHost {
  constructor() {
    const host = inject(ElementRef).nativeElement as HTMLElement;
    const references = clientReferences(inject(CLIENT_REFERENCES));
    const appRef = inject(ApplicationRef);
    const environmentInjector = inject(EnvironmentInjector);
    const elementInjector = inject(Injector);
    const islands: ComponentRef<unknown>[] = [];

    const commit = (plan: readonly PlannedClientBoundary<HTMLElement>[]): void => {
      const created: ComponentRef<unknown>[] = [];
      const positions = plan.map(({ host }) => [host, host.parentNode, host.nextSibling] as const);

      try {
        for (const { host: hostElement, type, props } of plan) {
          const island = createComponent(type, {
            environmentInjector,
            elementInjector,
            hostElement,
          });

          created.push(island);
          for (const [name, value] of props) island.setInput(name, value);
          appRef.attachView(island.hostView);
        }
      } catch (error) {
        // Destroying a view also detaches it from the ApplicationRef.
        for (const island of created.reverse()) island.destroy();
        // Destroying a root ComponentRef detaches its host element, subtree
        // intact and inert: put the server-rendered DOM back where it was.
        for (const [hostElement, parent, next] of positions.reverse()) {
          if (!hostElement.isConnected) parent?.insertBefore(hostElement, next);
        }
        throw error;
      }

      islands.push(...created);
      for (const { host: hostElement } of plan) {
        hostElement.setAttribute(BOUNDARY_HYDRATED_ATTRIBUTE, "");
      }
    };

    afterNextRender(() => {
      commit(planClientBoundaries(host.localName, discoverBoundaries(host), references));
    });

    inject(DestroyRef).onDestroy(() => {
      for (const island of islands.splice(0)) island.destroy();
    });
  }
}
