import { Controller, Post } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

type FormFields = Readonly<Record<string, string | readonly string[]>>;

/** Handwritten Standard Schema v1 keeps this fixture independent of validators. */
const orderSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "fixture-validated-form",
    types: undefined as unknown as {
      readonly input: FormFields;
      readonly output: {
        readonly orderId: string;
        readonly tags: readonly string[];
        readonly note: string | undefined;
      };
    },
    async validate(value: unknown) {
      await Promise.resolve();
      if (value === null || typeof value !== "object")
        return { issues: [{ message: "private form schema detail" }] };
      const fields = value as FormFields;
      const orderId = fields["orderId"];
      const tags = fields["tag"];
      const note = fields["note"];
      if (typeof orderId !== "string" || !/^order-[a-z0-9-]+$/i.test(orderId)) {
        return { issues: [{ message: "private form schema detail" }] };
      }
      if (tags !== undefined && typeof tags !== "string" && !Array.isArray(tags)) {
        return { issues: [{ message: "private form schema detail" }] };
      }
      if (note !== undefined && typeof note !== "string") {
        return { issues: [{ message: "private form schema detail" }] };
      }
      const normalizedTags = tags === undefined ? [] : typeof tags === "string" ? [tags] : tags;
      if (!normalizedTags.every((tag) => typeof tag === "string")) {
        return { issues: [{ message: "private form schema detail" }] };
      }
      return { value: { orderId: orderId.toUpperCase(), tags: normalizedTags, note } };
    },
  },
};

const invalidSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "fixture-invalid-form",
    validate(value: unknown) {
      const fields = value as FormFields;
      return { issues: [{ message: `private-canary-${String(fields["secret"] ?? "missing")}` }] };
    },
  },
};

@Controller("/api/strata/forms")
export class FormsController {
  @Post("/orders")
  async create(request: StrataAnalogRequest) {
    const order = await request.readValidatedForm(orderSchema);
    return { ...order, correlation: request.headers.get("x-correlation-id") };
  }

  @Post("/invalid")
  invalid(request: StrataAnalogRequest) {
    return request.readValidatedForm(invalidSchema);
  }

  @Post("/cleanup-fail")
  cleanupFailure(request: StrataAnalogRequest) {
    return request.readValidatedForm(invalidSchema);
  }
}
