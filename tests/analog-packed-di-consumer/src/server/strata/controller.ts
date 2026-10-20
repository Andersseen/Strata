import { DestroyRef, inject } from "@angular/core";
import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

import { CatalogService, PACKED_DI_REQUEST, RequestIdentity, packedDiStats } from "./providers";

export const PACKED_DI_MARKER = "STRATA_PACKED_ANGULAR_DI_SERVER_MARKER";

@Controller("/api/packed-angular-di")
export class PackedDiController {
  private readonly catalog = inject(CatalogService);
  private readonly identity = inject(RequestIdentity);
  private readonly injectedRequest = inject(PACKED_DI_REQUEST);
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      packedDiStats.controllersDestroyed++;
    });
  }

  @Get("/:id")
  async getProduct(request: StrataAnalogRequest) {
    packedDiStats.handlerCalls++;
    await new Promise((resolve) => setTimeout(resolve, Number(request.query["delay"] ?? 0)));
    return {
      product: this.catalog.product(request.params["id"] ?? ""),
      principal: this.identity.principal,
      identity: this.identity.instance,
      catalogInstance: this.catalog.instance,
      requestIdentityStable:
        this.identity.request === this.injectedRequest && request === this.injectedRequest,
      destroyedBeforeResponse: this.destroyed,
      marker: PACKED_DI_MARKER,
    };
  }
}
