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
} from "@angular/core";
import type { ComponentRef, Provider } from "@angular/core";

import {
  BOUNDARY_HYDRATED_ATTRIBUTE,
  StrataBoundaryError,
  StrataBuildMismatchError,
} from "./boundary-protocol.js";
import { buildClientReferenceRegistry } from "./client-references.js";
import type { ClientReferenceInput } from "./client-references.js";
import { STRATA_BUILD_ID } from "./build-token.js";
import { STRATA_HYDRATION_OBSERVER, notifyStrataHydrationObserver } from "./hydration-observer.js";
import { BOUNDARY_HOST_SELECTOR, planClientBoundaries } from "./hydration-plan.js";
import type { PlannedClientBoundary } from "./hydration-plan.js";
import { SkewRecovery } from "./skew-recovery.js";

/** The interactive components a server component may render, by selector. */
const CLIENT_REFERENCES = new InjectionToken<readonly ClientReferenceInput[]>(
  "STRATA_CLIENT_REFERENCES",
);

/**
 * Provides the client components of one Server Component host. Each entry is a
 * component type, or `{ type, expectedSelector }` as generated surrogates emit
 * it so the runtime can check the component's real Angular selector against
 * the one the build authorized.
 */
export function provideClientReferences(references: readonly ClientReferenceInput[]): Provider {
  return { provide: CLIENT_REFERENCES, useValue: references };
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
    const registry = buildClientReferenceRegistry(inject(CLIENT_REFERENCES));
    const buildId = inject(STRATA_BUILD_ID);
    const recovery = inject(SkewRecovery);
    const observer = inject(STRATA_HYDRATION_OBSERVER, { optional: true });
    const appRef = inject(ApplicationRef);
    const environmentInjector = inject(EnvironmentInjector);
    const elementInjector = inject(Injector);
    const islands: ComponentRef<unknown>[] = [];
    let destroyed = false;

    const now = (): number => host.ownerDocument.defaultView?.performance.now() ?? 0;

    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      destroyed = true;
      for (const island of islands.splice(0)) island.destroy();
    });

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
      if (destroyed) return;
      const startedAt = observer ? now() : 0;
      const boundaries = discoverBoundaries(host);
      let plan: readonly PlannedClientBoundary<HTMLElement>[];
      try {
        plan = planClientBoundaries(
          host.localName,
          boundaries,
          registry.references,
          buildId,
          registry.problem,
        );
      } catch (error) {
        const refusal = error instanceof StrataBoundaryError;
        let mismatch: StrataBuildMismatchError | undefined;
        // Only a confirmed build mismatch is a candidate for recovery, and the
        // error is rethrown either way: the ErrorHandler still sees it.
        if (error instanceof StrataBuildMismatchError) {
          mismatch = error;
          recovery.handle(error);
        }
        if (observer)
          notifyStrataHydrationObserver(observer, {
            hostSelector: host.localName,
            outcome: refusal ? "preflight-refused" : "commit-failed",
            discoveredBoundaries: boundaries.length,
            committedBoundaries: 0,
            ...(refusal ? { failureCategory: error.category } : {}),
            buildMismatch: mismatch !== undefined,
            ...(mismatch ? { recoveryOutcome: mismatch.recovery } : {}),
            elapsedMs: Math.max(0, now() - startedAt),
          });
        throw error;
      }

      try {
        commit(plan);
      } catch (error) {
        if (observer)
          notifyStrataHydrationObserver(observer, {
            hostSelector: host.localName,
            outcome: "commit-failed",
            discoveredBoundaries: boundaries.length,
            committedBoundaries: 0,
            buildMismatch: false,
            elapsedMs: Math.max(0, now() - startedAt),
          });
        throw error;
      }

      if (observer)
        notifyStrataHydrationObserver(observer, {
          hostSelector: host.localName,
          outcome: "committed",
          discoveredBoundaries: boundaries.length,
          committedBoundaries: boundaries.length,
          buildMismatch: false,
          elapsedMs: Math.max(0, now() - startedAt),
        });
    });
  }
}
