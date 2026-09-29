import type { StrataAnalogRequest } from "@strata-sc/analog";
import { Controller, Get } from "@strata-sc/core";

import type { Environment, OperationsSnapshot } from "../../shared/operations.models";

import { operationsRepository } from "./operations.repository";
import type { OperationsRepository } from "./operations.repository";
import { RequestAudit, requestMetrics } from "./request-audit";

function environmentFrom(request: StrataAnalogRequest): Environment {
  return request.query["environment"] === "staging" ? "staging" : "production";
}

@Controller("/api/ops")
export class OperationsController {
  constructor(
    private readonly repository: OperationsRepository = operationsRepository,
    private readonly audit: RequestAudit = new RequestAudit(undefined),
  ) {}

  @Get("/snapshot")
  snapshot(request: StrataAnalogRequest): OperationsSnapshot {
    const environment = environmentFrom(request);

    return {
      services: this.repository.listServices(environment),
      incidents: this.repository.listIncidents(environment),
      activity: this.repository.listActivity(environment),
      request: {
        correlationId: this.audit.correlationId,
        completedScopes: requestMetrics.completed,
      },
    };
  }

  @Get("/services/:id")
  service(request: StrataAnalogRequest) {
    return (
      this.repository.findService(request.params["id"] ?? "") ?? { error: "Service not found" }
    );
  }
}
