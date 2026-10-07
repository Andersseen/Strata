import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

import { EXPECTED_CREDENTIAL_DIGEST, digest, readInternalCredential } from "./security-secret";

/** How a test-only route makes the repository fail with a secret-bearing error. */
export type SecurityFailure = "plain" | "cause" | "aggregate";

/** A stand-in for a database-backed repository that holds a credential. */
@Injectable({ providedIn: "root" })
export class SecurityRepository {
  // An own property on purpose: a serializer that walked this object (instead of
  // rejecting it) would emit the credential. The boundary must refuse it first.
  private readonly credential = readInternalCredential();

  /**
   * Uses the credential on the server: the answer depends on its value, and
   * only the boolean leaves this module.
   */
  verifyInternalConfiguration(): boolean {
    return digest(this.credential) === EXPECTED_CREDENTIAL_DIGEST;
  }

  /** A nested object holding the credential: a shape the boundary cannot carry. */
  describeConfiguration(): { readonly endpoint: string; readonly credential: string } {
    return { endpoint: "internal", credential: this.credential };
  }

  /** Test-only: fails with the credential in the error. Never returns. */
  failInternally(failure: SecurityFailure): never {
    switch (failure) {
      case "plain":
        throw new Error(`Synthetic server failure ${this.credential}`);
      case "cause":
        throw new Error("public wrapper", { cause: new Error(this.credential) });
      case "aggregate":
        throw new AggregateError([new Error(this.credential)], "Synthetic aggregate failure");
    }
  }
}
