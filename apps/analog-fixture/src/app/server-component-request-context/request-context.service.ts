import "@strata-sc/server-components/server-only";

import { Injectable, REQUEST_CONTEXT, inject } from "@angular/core";

import { RequestContextFixtureRepository } from "./request-context.repository";
import type { RequestContextFixtureValue } from "./request-context-types";

const HOLD_MS = 250;

@Injectable()
export class RequestContextFixtureService {
  private readonly context = inject(REQUEST_CONTEXT, {
    optional: true,
  }) as RequestContextFixtureValue | null;
  private readonly repository = inject(RequestContextFixtureRepository);

  async observe(): Promise<string> {
    if (!this.context) return "missing";

    if (this.context.operation === "fail") {
      throw new Error("synthetic repository operation failed");
    }

    // Keep every render open briefly so the harness can observe real overlap
    // without relying on a server-side barrier that may exceed workerd's
    // in-flight request limit on a constrained CI runner.
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));

    // The private value is consumed, but only a safe public verdict leaves the server.
    const privateValue = this.repository.readPrivateValue(this.context.id);
    return `${this.context.id}:${privateValue.startsWith("STRATA_REQUEST_PRIVATE_") ? "verified" : "invalid"}`;
  }
}
