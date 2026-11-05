// Consumer-authored use of every public declaration of the optional
// @strata-sc/server-components/ssr entry (strict, skipLibCheck: false). Typed against Node's real
// `ServerResponse`, which is what Analog's `RESPONSE` and `context.res` are; the Analog integration
// itself is checked by ssr-failure-analog.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

import { InjectionToken } from "@angular/core";
import type { ApplicationConfig } from "@angular/core";
import {
  STRATA_SSR_FAILURE_DOCUMENT,
  provideStrataSsrFailureHandler,
  withStrataSsrFailureContract,
} from "@strata-sc/server-components/ssr";
import type {
  StrataSsrFailure,
  StrataSsrFailureOptions,
  StrataSsrFailurePhase,
  StrataSsrRender,
  StrataSsrResponse,
} from "@strata-sc/server-components/ssr";

interface HostContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

const RESPONSE = new InjectionToken<ServerResponse>("RESPONSE");

export const serverConfig: ApplicationConfig = {
  providers: [provideStrataSsrFailureHandler(RESPONSE)],
};

declare const hostRender: (url: string, document: string, context: HostContext) => Promise<string>;

const options: StrataSsrFailureOptions = {
  failureDocument: STRATA_SSR_FAILURE_DOCUMENT,
  report: (failure: StrataSsrFailure) => {
    const phase: StrataSsrFailurePhase = failure.phase;
    // Safe production logging: class names only, never `failure.errors` text.
    console.error(`[ssr] ${phase}: ${failure.errorNames.join(", ")}`);
  },
};

export const wrapped: typeof hostRender = withStrataSsrFailureContract(hostRender, options);
export const typed: StrataSsrRender<HostContext> = wrapped;
export const response: StrataSsrResponse = {} as ServerResponse;

// @ts-expect-error -- the provider needs a token, not a response value.
provideStrataSsrFailureHandler({ statusCode: 200 });
declare const noResponse: (
  url: string,
  document: string,
  context: { req: unknown },
) => Promise<string>;
// @ts-expect-error -- a render context without a response object is refused.
withStrataSsrFailureContract(noResponse);
