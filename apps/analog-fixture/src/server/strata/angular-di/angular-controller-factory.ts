import { createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import type { StrataAnalogControllerFactory } from "@strata/analog";

import { RequestAudit, RequestIdentity, STRATA_REQUEST, angularDiStats } from "./providers";

/**
 * Consumer-owned glue, not part of `@strata/analog`: builds each controller
 * inside a new request injector — a child of the application injector — so
 * field initializers can use Angular's `inject()`, and hands that injector's
 * disposal to Strata through `onCleanup`. It is destroyed once the controller
 * invocation has settled, successfully or not.
 *
 * Only the providers listed here are request-scoped. Everything else resolves
 * up the parent chain in the application injector and lives for the process.
 */
export function createAngularControllerFactory(
  appInjector: Promise<EnvironmentInjector>,
): StrataAnalogControllerFactory {
  return async (Controller, { request, onCleanup }) => {
    const parent = await appInjector;
    const requestInjector = createEnvironmentInjector(
      [{ provide: STRATA_REQUEST, useValue: request }, RequestIdentity, RequestAudit],
      parent,
      `strata-request ${request.path}`,
    );

    angularDiStats.injectorsCreated++;
    angularDiStats.injectorsAlive++;
    angularDiStats.maxInjectorsAlive = Math.max(
      angularDiStats.maxInjectorsAlive,
      angularDiStats.injectorsAlive,
    );

    onCleanup(() => {
      requestInjector.destroy();
      angularDiStats.injectorsAlive--;
      angularDiStats.injectorsDestroyed++;
    });

    return runInInjectionContext(requestInjector, () => new Controller());
  };
}
