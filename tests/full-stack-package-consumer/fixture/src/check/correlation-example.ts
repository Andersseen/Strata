import { registerControllers } from "@strata-sc/analog";
import type {
  ControllerClass,
  NitroRouter,
  RegisterControllersOptions,
  StrataAnalogRequest,
  StrataAnalogRequestObservation,
} from "@strata-sc/analog";
import { Controller, Get } from "@strata-sc/core";

// Opt-in correlation: both fields are optional, readonly strings.
@Controller("/api/correlated")
class CorrelatedExample {
  @Get("/")
  read(request: StrataAnalogRequest): { id: string | undefined } {
    const id: string | undefined = request.correlationId;
    return { id };
  }
}

const onRequestSettled = (observation: StrataAnalogRequestObservation): void => {
  const id: string | undefined = observation.correlationId;
  void id;
};

export function register(router: NitroRouter): void {
  registerControllers(router, [CorrelatedExample as ControllerClass], {
    requestCorrelation: true,
    onRequestSettled,
  });
}

// @ts-expect-error the id is readonly
const mutate = (request: StrataAnalogRequest): void => void (request.correlationId = "x");
void mutate;

export const invalid: RegisterControllersOptions = {
  // @ts-expect-error the option is a boolean
  requestCorrelation: "yes",
};
