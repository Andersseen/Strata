import { Injector, runInInjectionContext } from "@angular/core";
import type { StrataAnalogControllerFactory } from "@strata/analog";

import { REQUEST_INJECTOR_ID, RequestScope, STRATA_REQUEST } from "./providers";

/** Request injectors created/destroyed, and controller `DestroyRef` callbacks run. */
export const angularDiStats = { created: 0, destroyed: 0, controllersReleased: 0 };

/**
 * Consumer-owned glue, not part of `@strata/analog`: builds each controller
 * inside a new child injector of `appInjector`, so field initializers can use
 * Angular's `inject()`, and hands the injector's disposal to Strata through
 * `onCleanup` — it is destroyed once the controller invocation has settled.
 */
export function createAngularControllerFactory(
  appInjector: Injector,
): StrataAnalogControllerFactory {
  return (Controller, { request, onCleanup }) => {
    const injectorId = ++angularDiStats.created;
    const requestInjector = Injector.create({
      name: `strata-request ${String(injectorId)}`,
      parent: appInjector,
      providers: [
        { provide: STRATA_REQUEST, useValue: request },
        { provide: REQUEST_INJECTOR_ID, useValue: injectorId },
        {
          provide: RequestScope,
          useFactory: () => new RequestScope(String(request.query["id"] ?? "")),
        },
      ],
    });

    onCleanup(() => {
      requestInjector.destroy();
      angularDiStats.destroyed++;
    });

    return runInInjectionContext(requestInjector, () => new Controller());
  };
}
