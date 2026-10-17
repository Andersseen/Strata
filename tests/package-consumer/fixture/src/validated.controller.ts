import { Controller, Post } from "@strata-sc/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { StrataAnalogRequest } from "@strata-sc/analog";

const bodySchema: StandardSchemaV1<{ count: string }, { count: number }> = {
  "~standard": {
    version: 1,
    vendor: "packed-consumer-fixture",
    types: undefined as unknown as StandardSchemaV1.Types<{ count: string }, { count: number }>,
    validate(value) {
      if (
        value !== null &&
        typeof value === "object" &&
        "count" in value &&
        typeof value.count === "string" &&
        /^\d+$/.test(value.count)
      ) {
        return { value: { count: Number(value.count) } };
      }
      return { issues: [{ message: "private fixture message" }] };
    },
  },
};

@Controller("/api/validated")
export class ValidatedController {
  @Post()
  async create(request: StrataAnalogRequest) {
    const output: Promise<{ count: number }> = request.readValidatedJson(bodySchema);
    return output;
  }
}
