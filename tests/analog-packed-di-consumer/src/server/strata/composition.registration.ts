import { createEnvironmentInjector, inject, runInInjectionContext } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import { registerControllers } from "@strata-sc/analog";
import type {
  NitroRouter,
  StrataAnalogControllerFactory,
  StrataAnalogGuard,
  StrataAnalogInterceptor,
  StrataAnalogRequest,
  StrataAnalogRequestObserver,
} from "@strata-sc/analog";

import { PackedCompositionController } from "./composition.controller";
import {
  COMPOSITION_AUDIT_SINK,
  COMPOSITION_PRINCIPAL,
  COMPOSITION_PRIVATE_CANARY,
  COMPOSITION_REQUEST,
  CompositionIdentity,
  closeTrace,
  compositionStats,
  onceCounted,
  openTrace,
  step,
  stepsOf,
} from "./composition.providers";

const credentials = new Map<string, "alpha" | "beta">([
  ["packed-alpha", "alpha"],
  ["packed-beta", "beta"],
]);
/** Product ids reserved for one principal: the guard answers 403 to the other. */
const owners = new Map<string, "alpha" | "beta">([
  ["900", "alpha"],
  ["901", "beta"],
]);
const principals = new WeakMap<StrataAnalogRequest, "alpha" | "beta">();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !(value instanceof Response) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * The composed matrix: one guard, two interceptors (outer, inner), a consumer-owned Angular
 * child injector per invocation, a settlement observer and request correlation, registered on
 * the same Nitro router as the other packed DI controller, in a separate call.
 */
export function registerPackedComposition(router: NitroRouter, root: EnvironmentInjector): void {
  const guard: StrataAnalogGuard = async ({ request, onCleanup }) => {
    compositionStats.guardEntered++;
    openTrace(request);
    onceCounted(onCleanup, request, "guard", () => compositionStats.guardCleanups++);
    await Promise.resolve();
    const header = request.headers.get("authorization") ?? "";
    const principal = credentials.get(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (!principal) return { allow: false, status: 401 };
    const owner = owners.get(request.params["id"] ?? "");
    if (owner && owner !== principal) return { allow: false, status: 403 };
    principals.set(request, principal);
    return { allow: true };
  };

  /** Outer: transforms plain results, never a native Response. */
  const outer: StrataAnalogInterceptor = async ({ request, onCleanup }, next) => {
    compositionStats.interceptorEntries++;
    step(request, "outer:before");
    onceCounted(
      onCleanup,
      request,
      "outer",
      () => compositionStats.interceptorCleanups++,
      request.query["cleanup"] === "both" ? "outer cleanup failed" : undefined,
    );
    try {
      const result = await next();
      step(request, "outer:after");
      return isPlainObject(result)
        ? { ...result, transformedBy: "outer", order: stepsOf(request) }
        : result;
    } catch (error) {
      step(request, "outer:error");
      throw error;
    }
  };

  /** Inner: the failure, misuse and replacement modes. */
  const inner: StrataAnalogInterceptor = async ({ request, onCleanup }, next) => {
    compositionStats.interceptorEntries++;
    step(request, "inner:before");
    const cleanup = request.query["cleanup"];
    onceCounted(
      onCleanup,
      request,
      "inner",
      () => compositionStats.interceptorCleanups++,
      cleanup === "inner" || cleanup === "both" ? "inner cleanup failed" : undefined,
    );
    const fail = request.query["fail"];
    try {
      if (fail === "interceptor-before") {
        throw new Error(`interceptor failed before next ${COMPOSITION_PRIVATE_CANARY}`);
      }
      const result =
        fail === "next-twice" ? (await Promise.all([next(), next()]))[0] : await next();
      step(request, "inner:after");
      if (fail === "interceptor-after") {
        throw new Error(`interceptor failed after next ${COMPOSITION_PRIVATE_CANARY}`);
      }
      if (request.query["replace"] === "true") {
        return new Response("replaced-by-interceptor", {
          status: 202,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return result;
    } catch (error) {
      step(request, "inner:error");
      throw error;
    }
  };

  const factory: StrataAnalogControllerFactory = (ControllerClass, { request, onCleanup }) => {
    compositionStats.factoryCalls++;
    step(request, "factory");
    if (request.query["fail"] === "factory") {
      throw new Error(`controller factory failed ${COMPOSITION_PRIVATE_CANARY}`);
    }
    const principal = principals.get(request);
    if (!principal) throw new Error("Verified principal missing");
    const injector = createEnvironmentInjector(
      [
        { provide: COMPOSITION_REQUEST, useValue: request },
        { provide: COMPOSITION_PRINCIPAL, useValue: principal },
        {
          provide: COMPOSITION_AUDIT_SINK,
          useFactory: () => {
            if (inject(COMPOSITION_REQUEST).query["fail"] === "provider") {
              throw new Error(`request provider failed ${COMPOSITION_PRIVATE_CANARY}`);
            }
            return "request-audit";
          },
        },
        CompositionIdentity,
      ],
      root,
    );
    compositionStats.injectorsCreated++;
    compositionStats.live++;
    compositionStats.maxLive = Math.max(compositionStats.maxLive, compositionStats.live);
    // Registered before construction, so a failing constructor still destroys the injector.
    onceCounted(onCleanup, request, "injector", () => {
      injector.destroy();
      compositionStats.injectorsDestroyed++;
      compositionStats.live--;
    });
    return runInInjectionContext(injector, () => new ControllerClass());
  };

  const observer: StrataAnalogRequestObserver = (observation) =>
    closeTrace(observation.correlationId, {
      outcome: observation.outcome,
      status: observation.status ?? null,
      phase: observation.phase,
      cleanup: observation.cleanup,
    });

  registerControllers(router, [PackedCompositionController], {
    guards: [guard],
    interceptors: [outer, inner],
    controllerFactory: factory,
    onRequestSettled: observer,
    requestCorrelation: true,
  });
}
