// Consumer-authored use of the public declarations of @strata-sc/core and
// @strata-sc/analog, compiled with standard (TC39) decorators.
import { Controller, Get, STRATA_VERSION, getControllerDefinition } from "@strata-sc/core";
import { registerControllers } from "@strata-sc/analog";
import type { NitroRouter, StrataAnalogGuard, StrataAnalogRequest } from "@strata-sc/analog";
import type { StandardSchemaV1 } from "@standard-schema/spec";

const paramsSchema: StandardSchemaV1<{ id: string }, { id: number }> = {
  "~standard": {
    version: 1,
    vendor: "declaration-consumer",
    types: undefined as unknown as StandardSchemaV1.Types<{ id: string }, { id: number }>,
    validate(value) {
      return value !== null &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string"
        ? { value: { id: Number(value.id) } }
        : { issues: [{ message: "invalid" }] };
    },
  },
};

@Controller("/api/check")
export class CheckController {
  @Get("/:id")
  async find(request: StrataAnalogRequest) {
    const output: Promise<{ id: number }> = request.validateParams(paramsSchema);
    return { id: (await output).id };
  }
}

export const definition = getControllerDefinition(CheckController);
export const version: string = STRATA_VERSION;

const guard: StrataAnalogGuard = async ({ request, route, onCleanup }) => {
  const method: string = route.method;
  const path: string = route.path;
  void request;
  onCleanup(() => undefined);
  return method && path ? { allow: true } : { allow: false, status: 403 };
};

export function register(router: NitroRouter): NitroRouter {
  return registerControllers(router, [CheckController], {
    guards: [guard],
    controllerFactory: (controller, { onCleanup }) => {
      onCleanup(() => undefined);

      return new controller();
    },
  });
}
