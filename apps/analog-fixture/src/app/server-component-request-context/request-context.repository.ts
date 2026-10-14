import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

import type { RequestContextIdentity } from "./request-context-types";

const PRIVATE_VALUES: Record<RequestContextIdentity, string> = {
  alpha: "STRATA_REQUEST_PRIVATE_ALPHA_5B7C9D1E",
  beta: "STRATA_REQUEST_PRIVATE_BETA_2F8A4C6D",
};

@Injectable()
export class RequestContextFixtureRepository {
  readPrivateValue(id: RequestContextIdentity): string {
    return PRIVATE_VALUES[id];
  }
}
