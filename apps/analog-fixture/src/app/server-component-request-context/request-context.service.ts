import "@strata-sc/server-components/server-only";

import { Injectable, REQUEST_CONTEXT, inject } from "@angular/core";

import type { RequestContextFixtureValue } from "./request-context-types";

const SYNTHETIC_CONFIDENTIAL_VALUE = "request-context-confidential-alpha-beta";
const HOLD_MS = 250;

@Injectable()
export class RequestContextFixtureService {
  private readonly context = inject(REQUEST_CONTEXT, {
    optional: true,
  }) as RequestContextFixtureValue | null;

  async observe(): Promise<string> {
    if (!this.context) return "missing";

    // Keep every render open briefly so the harness can observe real overlap
    // without relying on a server-side barrier that may exceed workerd's
    // in-flight request limit on a constrained CI runner.
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));

    // The confidential value is consumed, but only a safe public verdict leaves the server.
    const confidentialCheck = this.context.confidential === SYNTHETIC_CONFIDENTIAL_VALUE;
    return `${this.context.id}:${confidentialCheck ? "verified" : "invalid"}`;
  }
}
