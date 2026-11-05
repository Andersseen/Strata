import type { H3Event } from "h3";
import { getRequestHeader, getRouterParam, readRawBody } from "h3";

import {
  BODY_LIMIT_BYTES,
  ITEM_INPUT,
  PRIVATE_FAILURE,
  RequestLedger,
  findScaleItem,
  scaleAnswer,
} from "./domain";
import type { ScaleResource } from "./domain";

// Native Nitro handlers with the SAME behavior as the Strata controllers: authorization before
// the request-scoped ledger, the same Standard Schema, the same 1 MiB limit and safe answers,
// and the ledger released exactly once in `finally`. No Strata package is imported.

export const SCALE_NATIVE_MARKER = "PERF_SCALE_NATIVE_MARKER";

const answer = (status: number, body: unknown): Response =>
  scaleAnswer(status, body, SCALE_NATIVE_MARKER);

async function scoped(
  resource: ScaleResource,
  work: (ledger: RequestLedger) => Response | Promise<Response>,
): Promise<Response> {
  const ledger = new RequestLedger(resource);

  try {
    return await work(ledger);
  } finally {
    ledger.release();
  }
}

export const scaleRead = (resource: ScaleResource, event: H3Event): Promise<Response> =>
  scoped(resource, (ledger) => {
    const item = findScaleItem(ledger, getRouterParam(event, "id") ?? "");

    return item ? answer(200, item) : answer(404, { error: "not_found" });
  });

export const scaleCreate = (resource: ScaleResource, event: H3Event): Promise<Response> =>
  scoped(resource, async (ledger) => {
    if (!(getRequestHeader(event, "content-type") ?? "").startsWith("application/json"))
      return answer(415, { error: "unsupported_media_type" });
    if (Number(getRequestHeader(event, "content-length") ?? "0") > BODY_LIMIT_BYTES)
      return answer(413, { error: "payload_too_large" });

    const text = (await readRawBody(event, "utf8")) ?? "";

    if (Buffer.byteLength(text) > BODY_LIMIT_BYTES)
      return answer(413, { error: "payload_too_large" });

    let value: unknown;

    try {
      value = JSON.parse(text);
    } catch {
      return answer(400, { error: "invalid_json" });
    }

    const result = await ITEM_INPUT["~standard"].validate(value);

    if (result.issues) return answer(400, { error: "invalid_input", source: "body" });
    ledger.read();

    return answer(201, { resource, ...result.value });
  });

export const scaleRemove = (
  resource: ScaleResource,
  event: H3Event,
): Promise<Response> | Response =>
  getRequestHeader(event, "x-perf-role") !== "admin"
    ? answer(403, { error: "forbidden" })
    : scoped(resource, (ledger) => {
        ledger.read();

        return answer(200, { deleted: getRouterParam(event, "id") });
      });

export const scaleFail = (resource: ScaleResource): Promise<Response> =>
  scoped(resource, () => {
    throw new Error(PRIVATE_FAILURE);
  });
