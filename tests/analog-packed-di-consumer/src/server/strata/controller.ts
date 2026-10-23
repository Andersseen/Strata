import { DestroyRef, inject } from "@angular/core";
import { Controller, Get } from "@strata-sc/core";
import { streamResponse } from "@strata-sc/analog";
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

  /**
   * The request injector must outlive the handler call: every row is read from it after the
   * handler has settled, and the injector is destroyed only when the body ends.
   */
  @Get("/:id/stream")
  stream(request: StrataAnalogRequest) {
    packedDiStats.handlerCalls++;
    const self = this;
    const id = request.params["id"] ?? "";

    return streamResponse(
      (async function* () {
        for (let row = 1; row <= 3; row++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          yield `${JSON.stringify({
            row,
            product: self.catalog.product(id),
            principal: self.identity.principal,
            destroyed: self.destroyed,
          })}\n`;
        }
      })(),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  }
}
