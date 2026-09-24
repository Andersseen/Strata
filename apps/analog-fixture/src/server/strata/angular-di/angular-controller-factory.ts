import { Injector, runInInjectionContext } from "@angular/core";
import type { DestroyableInjector } from "@angular/core";
import type { StrataAnalogControllerFactory } from "@strata/analog";

import { RequestScope, STRATA_REQUEST } from "./providers";

/**
 * Per-request slot a Nitro `request` hook puts on `event.context`. The
 * `StrataAnalogRequest` context is a shallow snapshot, so the factory sees the
 * same slot object and can hand its injector back to the hooks that destroy
 * it — `@strata/analog` itself has no release hook yet.
 */
export interface AngularDiScopeSlot {
  injector?: DestroyableInjector;
}

export const ANGULAR_DI_SCOPE_KEY = "strataAngularDiScope";

/** Request injectors created/destroyed, and controller `DestroyRef` callbacks run. */
export const angularDiStats = { created: 0, destroyed: 0, controllersReleased: 0 };

/**
 * Consumer-owned glue, not part of `@strata/analog`: builds each controller
 * inside a new child injector of `appInjector`, so field initializers can use
 * Angular's `inject()`.
 */
export function createAngularControllerFactory(
  appInjector: Injector,
): StrataAnalogControllerFactory {
  return (Controller, { request }) => {
    const slot = request.context[ANGULAR_DI_SCOPE_KEY] as AngularDiScopeSlot | undefined;

    if (!slot) {
      throw new Error("The Angular DI scope slot is missing: is the Nitro request hook installed?");
    }

    const requestInjector = Injector.create({
      name: `strata-request ${request.path}`,
      parent: appInjector,
      providers: [
        { provide: STRATA_REQUEST, useValue: request },
        {
          provide: RequestScope,
          useFactory: () => new RequestScope(String(request.query["id"] ?? "")),
        },
      ],
    });

    slot.injector = requestInjector;
    angularDiStats.created++;

    return runInInjectionContext(requestInjector, () => new Controller());
  };
}

export function destroyAngularDiScope(slot: AngularDiScopeSlot | undefined): void {
  const injector = slot?.injector;

  if (!injector) {
    return;
  }

  slot.injector = undefined;
  injector.destroy();
  angularDiStats.destroyed++;
}
