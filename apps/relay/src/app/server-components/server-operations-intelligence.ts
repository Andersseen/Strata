// Asserted server-only: the build fails if any browser code imports this module.
import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

// This marker is intentionally rendered through a hash and verified absent
// from Relay's browser output. It stands in for credentials, SDKs and database
// access that a real application must keep in the server graph.
export const RELAY_SERVER_ONLY_INTELLIGENCE_MARKER =
  "RELAY_SERVER_ONLY_OPERATIONS_INTELLIGENCE_7C21";

export interface OperationsBriefing {
  readonly alertId: string;
  readonly headline: string;
  readonly detail: string;
  readonly region: string;
  readonly confidence: number;
  readonly provenance: string;
}

export interface ReleaseAssessment {
  readonly service: string;
  readonly version: string;
  readonly riskScore: number;
  readonly recommendation: string;
  readonly reason: string;
  readonly provenance: string;
}

@Injectable({ providedIn: "root" })
export class ServerOperationsIntelligence {
  getBriefing(): OperationsBriefing {
    return {
      alertId: "brief-eu-west-checkout",
      headline: "Checkout traffic has stabilized",
      detail: "The secondary payment route is carrying 38% of eu-west traffic without errors.",
      region: "eu-west-1",
      confidence: 94,
      provenance: fingerprint(`${RELAY_SERVER_ONLY_INTELLIGENCE_MARKER}:briefing`),
    };
  }

  assessRelease(): ReleaseAssessment {
    return {
      service: "Checkout API",
      version: "v2.19.0",
      riskScore: 34,
      recommendation: "Canary to 25%",
      reason: "Error budget is healthy, but the active provider mitigation raises rollout risk.",
      provenance: fingerprint(`${RELAY_SERVER_ONLY_INTELLIGENCE_MARKER}:release`),
    };
  }
}

/** A 32-bit string hash, evaluated at runtime. */
export function fingerprint(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(16);
}
