// The documented Analog integration of @strata-sc/server-components/ssr, type-checked against
// Analog's REAL `render()` and `RESPONSE` (tsconfig.check.analog-ssr.json). skipLibCheck is true
// there only because Analog's own declarations reference Nitro and database driver types this
// consumer does not install; every line of THIS file is still checked strictly.
import { render } from "@analogjs/router/server";
import { RESPONSE } from "@analogjs/router/tokens";
import type { ServerContext } from "@analogjs/router/tokens";
import { Component } from "@angular/core";
import type { ApplicationConfig } from "@angular/core";
import {
  provideStrataSsrFailureHandler,
  withStrataSsrFailureContract,
} from "@strata-sc/server-components/ssr";
import type { StrataSsrRender } from "@strata-sc/server-components/ssr";

@Component({ selector: "check-ssr-root", template: "" })
export class CheckSsrRoot {}

export const config: ApplicationConfig = {
  providers: [provideStrataSsrFailureHandler(RESPONSE)],
};

const analogRender = render(CheckSsrRoot, config);

// The wrapper keeps Analog's exact render signature, so Nitro's renderer accepts it unchanged.
export const entry: typeof analogRender = withStrataSsrFailureContract(analogRender, {
  report: ({ phase, errorNames }) => console.error(`[ssr] ${phase}: ${errorNames.join(", ")}`),
});
export const typed: StrataSsrRender<ServerContext> = entry;
