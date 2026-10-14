import "@strata-sc/server-components/server-only";

import { Injectable, REQUEST_CONTEXT, inject } from "@angular/core";

import { waitForConcurrentRound } from "./request-context-barrier";
import type { RequestContextFixtureValue } from "./request-context-types";

const SYNTHETIC_CONFIDENTIAL_VALUE = "request-context-confidential-alpha-beta";

@Injectable()
export class RequestContextFixtureService {
  private readonly context = inject(REQUEST_CONTEXT, {
    optional: true,
  }) as RequestContextFixtureValue | null;

  async observe(): Promise<string> {
    if (!this.context) return "missing";

    await waitForConcurrentRound(this.context.round, `${this.context.id}-${crypto.randomUUID()}`);

    // The confidential value is consumed, but only a safe public verdict leaves the server.
    const confidentialCheck = this.context.confidential === SYNTHETIC_CONFIDENTIAL_VALUE;
    return `${this.context.id}:${confidentialCheck ? "verified" : "invalid"}`;
  }
}
