import { DestroyRef, inject } from "@angular/core";
import type { StrataAnalogRequest } from "@strata/analog";
import { Controller, Get } from "@strata/core";

import {
  AppGreetingService,
  REQUEST_INJECTOR_ID,
  RequestScope,
  STRATA_ANALOG_ANGULAR_DI_MARKER,
  STRATA_REQUEST,
} from "./providers";
import { angularDiStats } from "./angular-controller-factory";

// Dependencies are resolved in field initializers, inside the injection
// context the controllerFactory opens, and kept across `await` — no ambient
// `inject()` after the first `await`.
@Controller("/api/strata/angular-di")
export class AngularDiController {
  static readonly serverOnlyMarker = STRATA_ANALOG_ANGULAR_DI_MARKER;

  private readonly app = inject(AppGreetingService);
  private readonly scope = inject(RequestScope);
  private readonly injectedRequest = inject(STRATA_REQUEST);
  private readonly injectorId = inject(REQUEST_INJECTOR_ID);
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      angularDiStats.controllersReleased++;
    });
  }

  @Get()
  async handle(request: StrataAnalogRequest) {
    const delay = Number(request.query["delay"] ?? 0);

    // Lets the harness overlap two requests while both controllers are alive.
    // Strata's cleanup (which destroys the request injector) must not run
    // before this last `await` has settled.
    await new Promise((resolve) => setTimeout(resolve, delay));

    return {
      requestId: this.scope.requestId,
      greeting: this.app.greet(),
      appInstance: this.app.instance,
      scopeInstance: this.scope.instance,
      injectorId: this.injectorId,
      sameRequest: this.injectedRequest === request,
      destroyedBeforeResponse: this.destroyed,
    };
  }
}
