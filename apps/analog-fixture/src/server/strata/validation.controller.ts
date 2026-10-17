import { Controller, Get, Post } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

function schema<Input, Output>(
  vendor: string,
  transform: (value: unknown) => Output | undefined,
  async = false,
) {
  return {
    "~standard": {
      version: 1,
      vendor,
      types: undefined as unknown as { readonly input: Input; readonly output: Output },
      validate: async
        ? async (value) => {
            await Promise.resolve();
            const output = transform(value);
            return output === undefined
              ? { issues: [{ message: "fixture-private-validation-detail" }] }
              : { value: output };
          }
        : (value) => {
            const output = transform(value);
            return output === undefined
              ? { issues: [{ message: "fixture-private-validation-detail" }] }
              : { value: output };
          },
    },
  };
}

const paramsSchema = schema<{ id: string }, { id: number }>("fixture-params", (value) => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^\d+$/.test(value.id)
  )
    return undefined;
  return { id: Number(value.id) };
});
const querySchema = schema<
  { tag: string | readonly string[] },
  { tag: string | readonly string[] }
>("fixture-query", (value) => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("tag" in value) ||
    (typeof value.tag !== "string" && !Array.isArray(value.tag))
  )
    return undefined;
  return { tag: value.tag };
});
const bodySchema = schema<{ count: string }, { count: number }>(
  "fixture-body",
  (value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      !("count" in value) ||
      typeof value.count !== "string" ||
      !/^\d+$/.test(value.count)
    )
      return undefined;
    return { count: Number(value.count) };
  },
  true,
);
const concurrentBodySchema = schema<
  { count: string; requestId: string },
  { count: number; requestId: string }
>(
  "fixture-concurrency-body",
  (value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      !("count" in value) ||
      !("requestId" in value) ||
      typeof value.count !== "string" ||
      typeof value.requestId !== "string" ||
      !/^\d+$/.test(value.count)
    )
      return undefined;
    return { count: Number(value.count), requestId: value.requestId };
  },
  true,
);

@Controller("/api/strata/validated")
export class ValidationController {
  @Get("/:id")
  async read(request: StrataAnalogRequest) {
    return {
      params: await request.validateParams(paramsSchema),
      query: await request.validateQuery(querySchema),
    };
  }

  @Post()
  async create(request: StrataAnalogRequest) {
    return request.readValidatedJson(bodySchema);
  }

  @Post("/:id")
  async concurrent(request: StrataAnalogRequest) {
    const params = await request.validateParams(paramsSchema);
    const query = await request.validateQuery(querySchema);
    const body = await request.readValidatedJson(concurrentBodySchema);
    await new Promise((resolve) => setTimeout(resolve, params.id % 4));
    return { id: params.id, tag: query.tag, count: body.count, requestId: body.requestId };
  }
}
