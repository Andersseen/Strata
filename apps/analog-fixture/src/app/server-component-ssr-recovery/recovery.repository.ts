import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

const PRIVATE_RECORD = "STRATA_RECOVERY_PRIVATE_4C8A2E71";

export class ExpectedRecoveryRepositoryFailure extends Error {
  constructor() {
    super(`Synthetic repository unavailable for ${PRIVATE_RECORD}`);
    this.name = "ExpectedRecoveryRepositoryFailure";
  }
}

@Injectable()
export class RecoveryRepository {
  read(mode: "success" | "unavailable"): { readonly itemCount: number } {
    if (mode === "unavailable") throw new ExpectedRecoveryRepositoryFailure();

    if (!PRIVATE_RECORD.startsWith("STRATA_RECOVERY_PRIVATE_")) {
      throw new Error("Synthetic repository integrity failure");
    }

    return { itemCount: 3 };
  }
}
