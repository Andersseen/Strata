import { createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import type { StrataAnalogControllerFactory } from "@strata-sc/analog";

import {
  REQUEST_CONFIGURATION,
  RequestAudit,
  RequestIdentity,
  STRATA_REQUEST,
  VERIFIED_PRINCIPAL,
  angularDiStats,
  getCompositionTrace,
  getVerifiedPrincipal,
} from "./providers";

/**
 * Consumer-owned glue, not part of `@strata-sc/analog`: builds each controller
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
    if (request.query["factoryFailure"] === "true") {
      throw new Error("Request failed.");
    }
    const parent = await appInjector;
    const override = request.query["override"];
    const requestConfigurationProvider =
      request.query["providerFailure"] === "true"
        ? {
            provide: REQUEST_CONFIGURATION,
            useFactory: () => {
              throw new Error("Request failed.");
            },
          }
        : typeof override === "string"
          ? { provide: REQUEST_CONFIGURATION, useValue: override }
          : undefined;
    const principal = getVerifiedPrincipal(request);
    const requestInjector = createEnvironmentInjector(
      [
        { provide: STRATA_REQUEST, useValue: request },
        ...(requestConfigurationProvider ? [requestConfigurationProvider] : []),
        ...(principal ? [{ provide: VERIFIED_PRINCIPAL, useValue: principal }] : []),
        RequestIdentity,
        RequestAudit,
      ],
      parent,
      `strata-request ${request.path}`,
    );

    angularDiStats.injectorsCreated++;
    angularDiStats.injectorsAlive++;
    angularDiStats.maxInjectorsAlive = Math.max(
      angularDiStats.maxInjectorsAlive,
      angularDiStats.injectorsAlive,
    );
    getCompositionTrace(request)?.push("injector:created");

    onCleanup(() => {
      // This runs only after every awaited interceptor has fully unwound.
      // The fixture's shared trace lets the runner assert LIFO cleanup order.
      getCompositionTrace(request)?.push("cleanup:injector");
      requestInjector.destroy();
      angularDiStats.injectorsAlive--;
      angularDiStats.injectorsDestroyed++;
    });

    return runInInjectionContext(requestInjector, () => new Controller());
  };
}
