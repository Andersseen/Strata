import "@strata-sc/server-components/server-only";

import { Injectable, inject } from "@angular/core";
import { REQUEST as ANALOG_REQUEST, RESPONSE as ANALOG_RESPONSE } from "@analogjs/router/tokens";
import type { ServerRequest, ServerResponse } from "@analogjs/router/tokens";

import { ExpectedRecoveryRepositoryFailure, RecoveryRepository } from "./recovery.repository";

export type RecoveryResult =
  | { readonly kind: "success"; readonly itemCount: number }
  | { readonly kind: "expected-failure"; readonly code: "repository-unavailable" }
  | { readonly kind: "invalid-context"; readonly code: "missing" | "malformed" };

type RecoveryMode = "success" | "unavailable" | "missing-context" | "malformed-context";

@Injectable()
export class RecoveryService {
  private readonly request = inject(ANALOG_REQUEST, { optional: true }) as ServerRequest | null;
  private readonly response = inject(ANALOG_RESPONSE, { optional: true }) as ServerResponse | null;
  private readonly repository = inject(RecoveryRepository);

  read(): RecoveryResult {
    const mode = this.mode();

    if (mode === "missing-context") {
      this.markResponse(400);

      return { kind: "invalid-context", code: "missing" };
    }

    if (mode === "malformed-context") {
      this.markResponse(400);

      return { kind: "invalid-context", code: "malformed" };
    }

    try {
      return { kind: "success", ...this.repository.read(mode) };
    } catch (error) {
      if (!(error instanceof ExpectedRecoveryRepositoryFailure)) throw error;

      this.markResponse(503);

      return { kind: "expected-failure", code: "repository-unavailable" };
    }
  }

  private mode(): RecoveryMode {
    const originalUrl = this.request?.originalUrl ?? this.request?.url;
    if (!originalUrl) return "missing-context";

    let url: URL;
    try {
      url = new URL(originalUrl, "http://localhost");
    } catch {
      return "malformed-context";
    }

    const mode = url.searchParams.get("mode");
    if (mode === null || mode === "success") return "success";
    if (mode === "unavailable") return "unavailable";
    if (mode === "missing-context") return "missing-context";
    if (mode === "malformed-context") return "malformed-context";

    return "malformed-context";
  }

  private markResponse(status: number): void {
    const response = this.response;
    if (!response || response.headersSent) return;

    response.statusCode = status;
    response.setHeader("cache-control", "no-store");
  }
}
