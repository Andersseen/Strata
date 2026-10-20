import "@angular/compiler";

import { createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import { createApplication } from "@angular/platform-browser";
import { platformServer, provideServerRendering } from "@angular/platform-server";
import { registerControllers } from "@strata-sc/analog";
import type {
  StrataAnalogControllerFactory,
  StrataAnalogGuard,
  StrataAnalogInterceptor,
  StrataAnalogRequest,
} from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { PackedDiController } from "../strata/controller";
import {
  PACKED_DI_PRINCIPAL,
  PACKED_DI_REQUEST,
  RequestIdentity,
  packedDiStats,
} from "../strata/providers";

const credentials = new Map<string, "alpha" | "beta">([
  ["packed-alpha", "alpha"],
  ["packed-beta", "beta"],
]);
const owners = new Map([
  ["alpha-only", "alpha"],
  ["beta-only", "beta"],
] as const);
const principals = new WeakMap<StrataAnalogRequest, "alpha" | "beta">();

export default defineNitroPlugin(async (nitroApp) => {
  const platform = platformServer();
  let application;
  try {
    application = await createApplication(
      { providers: [provideServerRendering()] },
      { platformRef: platform },
    );
  } catch (error) {
    platform.destroy();
    throw error;
  }
  let closed = false;
  nitroApp.hooks.hook("close", () => {
    if (closed) return;
    closed = true;
    application!.destroy();
    platform.destroy();
    console.info("packed angular DI root closed");
  });

  const guard: StrataAnalogGuard = ({ request, onCleanup }) => {
    onCleanup(() => {
      packedDiStats.guardCleanups++;
    });
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const principal = credentials.get(token);
    if (!principal) return { allow: false, status: 401 };
    if (
      owners.has(request.params["id"] ?? "") &&
      owners.get(request.params["id"] ?? "") !== principal
    ) {
      return { allow: false, status: 403 };
    }
    principals.set(request, principal);
    return { allow: true };
  };
  const interceptor: StrataAnalogInterceptor = async (_context, next) => {
    packedDiStats.interceptorCalls++;
    return next();
  };
  const factory: StrataAnalogControllerFactory = (ControllerClass, { request, onCleanup }) => {
    const principal = principals.get(request);
    if (!principal) throw new Error("Verified principal missing");
    const injector: EnvironmentInjector = createEnvironmentInjector(
      [
        { provide: PACKED_DI_REQUEST, useValue: request },
        { provide: PACKED_DI_PRINCIPAL, useValue: principal },
        RequestIdentity,
      ],
      application!.injector,
    );
    packedDiStats.injectorsCreated++;
    packedDiStats.live++;
    onCleanup(() => {
      injector.destroy();
      packedDiStats.injectorsDestroyed++;
      packedDiStats.live--;
    });
    return runInInjectionContext(injector, () => new ControllerClass());
  };
  registerControllers(nitroApp.router, [PackedDiController], {
    guards: [guard],
    interceptors: [interceptor],
    controllerFactory: factory,
  });
});
