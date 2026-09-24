import { Injectable, InjectionToken, inject } from "@angular/core";
import type { OnDestroy } from "@angular/core";
import type { StrataAnalogRequest } from "@strata/analog";

// Server-only: imported only by the Nitro plugin and the controller it
// registers. The production-build scan asserts the marker never reaches the
// client output.
export const STRATA_ANALOG_ANGULAR_DI_MARKER = "STRATA_ANALOG_ANGULAR_DI_MARKER";

/**
 * Counters the harness reads through `/api/strata-angular-di-stats`. It takes a
 * snapshot before and after each scenario and compares the difference, so the
 * counters never need resetting.
 */
export const angularDiStats = {
  /** Request injectors created by the controller factory. */
  injectorsCreated: 0,
  /** Request injectors destroyed through `onCleanup`. */
  injectorsDestroyed: 0,
  /** Request injectors alive right now, and the highest that number has reached. */
  injectorsAlive: 0,
  maxInjectorsAlive: 0,
  /** `RequestIdentity.ngOnDestroy()` calls, run by Angular when a request injector is destroyed. */
  identitiesDestroyed: 0,
  /** Controller `DestroyRef.onDestroy()` callbacks, run by the same destruction. */
  controllersReleased: 0,
  /** `CatalogService` instances: must stay at 1 for the whole process. */
  catalogInstances: 0,
};

/** The Strata request the current request injector was created for. */
export const STRATA_REQUEST = new InjectionToken<StrataAnalogRequest>("STRATA_REQUEST");

/**
 * Stand-in for a future application-level integration (a CMS runtime, a
 * database client): created once, in the application injector, and shared by
 * every request. `providedIn: 'root'` resolves only because that injector is a
 * real Angular application injector (`createApplication()`), not a bare
 * `Injector.create()`.
 */
@Injectable({ providedIn: "root" })
export class CatalogService {
  readonly instance = ++angularDiStats.catalogInstances;

  findProduct(id: string) {
    return { id, name: `Product ${id}` };
  }
}

let identities = 0;

/**
 * Request lifetime: listed in the providers of every request injector, never
 * in the application injector, so each request builds its own. Records which
 * request it was created for, so a response can prove it never saw another
 * request's instance.
 */
@Injectable()
export class RequestIdentity implements OnDestroy {
  readonly id = ++identities;
  readonly productId = inject(STRATA_REQUEST).params["id"] ?? "";

  ngOnDestroy() {
    angularDiStats.identitiesDestroyed++;
  }
}

/**
 * Request lifetime too; depends on `RequestIdentity`. Resolving the identity
 * both here and in the controller must yield the same instance within one
 * request.
 */
@Injectable()
export class RequestAudit {
  readonly identity = inject(RequestIdentity);
}
