// Consumer-authored use of the public declarations of @strata-sc/core and
// @strata-sc/analog, compiled with standard (TC39) decorators.
import { Controller, Get, STRATA_VERSION, getControllerDefinition } from "@strata-sc/core";
import { registerControllers } from "@strata-sc/analog";
import type { NitroRouter, StrataAnalogRequest } from "@strata-sc/analog";

@Controller("/api/check")
export class CheckController {
  @Get("/:id")
  find(request: StrataAnalogRequest) {
    return { id: request.params["id"] };
  }
}

export const definition = getControllerDefinition(CheckController);
export const version: string = STRATA_VERSION;

export function register(router: NitroRouter): NitroRouter {
  return registerControllers(router, [CheckController], {
    controllerFactory: (controller, { onCleanup }) => {
      onCleanup(() => undefined);

      return new controller();
    },
  });
}
