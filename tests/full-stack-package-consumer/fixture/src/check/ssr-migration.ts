// The public /ssr changes of server-components 0.17.0, as a consumer's compiler sees them. Checked
// from 0.17.0 on: the recommended registration, and the two things that stop compiling or matching.
import { Component, InjectionToken } from "@angular/core";
import type { ApplicationConfig, EnvironmentProviders, Provider } from "@angular/core";
import { provideStrataSsrFailureHandler } from "@strata-sc/server-components/ssr";
import type { StrataSsrFailure, StrataSsrFailurePhase } from "@strata-sc/server-components/ssr";

const RESPONSE = new InjectionToken<{ statusCode: number }>("RESPONSE");

// Recommended: the application's server configuration.
export const providers: EnvironmentProviders = provideStrataSsrFailureHandler(RESPONSE);
export const serverConfig: ApplicationConfig = { providers: [providers] };

// @ts-expect-error -- since 0.17.0 this is EnvironmentProviders, no longer Provider[].
export const asArray: Provider[] = provideStrataSsrFailureHandler(RESPONSE);

@Component({
  selector: "ssr-migration-check",
  template: "",
  // @ts-expect-error -- environment providers cannot be registered on a component.
  providers: [provideStrataSsrFailureHandler(RESPONSE)],
})
export class RegisteredOnAComponent {}

/** An exhaustive switch written for 0.16.0 stops compiling until `integration` is handled. */
export function severity(failure: StrataSsrFailure): "page" | "operator" {
  const phase: StrataSsrFailurePhase = failure.phase;

  switch (phase) {
    case "render":
    case "rejection":
      return "page";
    case "integration":
      return "operator";
    default: {
      const unhandled: never = phase;

      return unhandled;
    }
  }
}
