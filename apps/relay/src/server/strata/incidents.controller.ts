import type { StrataAnalogRequest } from "@strata-sc/analog";
import { Controller, Patch, Post } from "@strata-sc/core";

import type { CreateIncidentInput, UpdateIncidentInput } from "../../shared/operations.models";

import { operationsRepository } from "./operations.repository";
import type { OperationsRepository } from "./operations.repository";
import { RequestAudit } from "./request-audit";

@Controller("/api/ops/incidents")
export class IncidentsController {
  constructor(
    private readonly repository: OperationsRepository = operationsRepository,
    private readonly audit: RequestAudit = new RequestAudit(undefined),
  ) {}

  @Post()
  async create(request: StrataAnalogRequest) {
    const input = await request.readJson<CreateIncidentInput>();
    return {
      incident: this.repository.createIncident(input),
      correlationId: this.audit.correlationId,
    };
  }

  @Patch("/:id")
  async update(request: StrataAnalogRequest) {
    const input = await request.readJson<UpdateIncidentInput>();
    const incident = this.repository.updateIncident(request.params["id"] ?? "", input.status);
    return { incident: incident ?? null, correlationId: this.audit.correlationId };
  }
}
