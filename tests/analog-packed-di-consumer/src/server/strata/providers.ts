import { Injectable, InjectionToken, inject } from "@angular/core";
import type { OnDestroy } from "@angular/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

export const PACKED_DI_REQUEST = new InjectionToken<StrataAnalogRequest>("PACKED_DI_REQUEST");
export const PACKED_DI_PRINCIPAL = new InjectionToken<"alpha" | "beta">("PACKED_DI_PRINCIPAL");

export const packedDiStats = {
  injectorsCreated: 0,
  injectorsDestroyed: 0,
  identitiesDestroyed: 0,
  controllersDestroyed: 0,
  guardCleanups: 0,
  interceptorCalls: 0,
  handlerCalls: 0,
  live: 0,
};
let catalogInstances = 0;
let requestIdentityInstances = 0;

@Injectable({ providedIn: "root" })
export class CatalogService {
  readonly instance = ++catalogInstances;
  product(id: string) {
    return { id, name: `Product ${id}` };
  }
}

@Injectable()
export class RequestIdentity implements OnDestroy {
  readonly instance = ++requestIdentityInstances;
  readonly request = inject(PACKED_DI_REQUEST);
  readonly principal = inject(PACKED_DI_PRINCIPAL);

  ngOnDestroy() {
    packedDiStats.identitiesDestroyed++;
  }
}
