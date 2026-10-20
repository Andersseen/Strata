import { createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import type {
  StrataAnalogControllerFactory,
  StrataAnalogGuard,
  StrataAnalogInterceptor,
} from "@strata-sc/analog";

import { PACKED_DI_PRINCIPAL, PACKED_DI_REQUEST, RequestIdentity } from "./providers";

export const consumerGuard: StrataAnalogGuard = ({ request }) =>
  request.headers.has("authorization") ? { allow: true } : { allow: false, status: 401 };

export const consumerInterceptor: StrataAnalogInterceptor = async (_context, next) => next();

export const createConsumerControllerFactory =
  (root: EnvironmentInjector): StrataAnalogControllerFactory =>
  (ControllerClass, { request, onCleanup }) => {
    const injector = createEnvironmentInjector(
      [
        { provide: PACKED_DI_REQUEST, useValue: request },
        { provide: PACKED_DI_PRINCIPAL, useValue: "alpha" as const },
        RequestIdentity,
      ],
      root,
    );
    onCleanup(() => injector.destroy());
    return runInInjectionContext(injector, () => new ControllerClass());
  };
