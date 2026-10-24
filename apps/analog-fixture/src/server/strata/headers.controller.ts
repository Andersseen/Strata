import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

/** Handwritten Standard Schema v1: the fixture needs no validation library. */
function schema<Output>(
  vendor: string,
  transform: (headers: Readonly<Record<string, string>>) => Output | undefined,
  async = false,
) {
  const run = (value: unknown) => {
    const output = transform(value as Readonly<Record<string, string>>);
    return output === undefined
      ? { issues: [{ message: "fixture-header-private-issue" }] }
      : { value: output };
  };
  return {
    "~standard": {
      version: 1 as const,
      vendor,
      types: undefined as unknown as { readonly input: unknown; readonly output: Output },
      validate: async
        ? async (value: unknown) => {
            await Promise.resolve();
            return run(value);
          }
        : run,
    },
  };
}

const metadataSchema = schema("fixture-headers", (headers) => {
  const requestId = headers["x-request-id"];
  const version = headers["x-client-version"];
  if (requestId === undefined || requestId.length === 0 || requestId.length > 128) return undefined;
  if (version === undefined || !/^\d+$/.test(version)) return undefined;
  return { requestId, version: Number(version), traced: headers["x-trace"] !== undefined };
});
const asyncSchema = schema(
  "fixture-headers-async",
  (headers) => (headers["x-token-class"] === "gold" ? { tier: "gold" as const } : undefined),
  true,
);
const throwingSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "fixture-headers-throwing",
    validate: (): never => {
      throw new Error("fixture-header-private-failure");
    },
  },
};

@Controller("/api/strata/observed/headers")
export class HeadersController {
  @Get("/metadata")
  async metadata(request: StrataAnalogRequest) {
    const meta = await request.validateHeaders(metadataSchema);
    await new Promise((resolve) => setTimeout(resolve, meta.version % 4));
    const again = await request.validateHeaders(metadataSchema);
    return { ...meta, stable: again.requestId === meta.requestId };
  }

  @Get("/async")
  async asynchronous(request: StrataAnalogRequest) {
    return request.validateHeaders(asyncSchema);
  }

  @Get("/throws")
  throws(request: StrataAnalogRequest) {
    return request.validateHeaders(throwingSchema);
  }
}
