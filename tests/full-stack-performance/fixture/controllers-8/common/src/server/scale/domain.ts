import type { StandardSchemaV1 } from "@standard-schema/spec";

// The eight-resource API of the controller scaling profile (STRATA_PERF_CONTROLLERS=8), shared by
// all four arms: the data, the request-scoped ledger, the input schema and the body limit. Only
// HOW a request reaches this code differs between the native routes and the Strata controllers.

export const SCALE_RESOURCES = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"] as const;
export type ScaleResource = (typeof SCALE_RESOURCES)[number];

export const BODY_LIMIT_BYTES = 1024 * 1024;

/** Thrown by the failing handler. It is server code: it must never reach a response or the browser. */
export const PRIVATE_FAILURE = "PERF_SCALE_PRIVATE_FAILURE_CANARY_7c2e";

const counters = { opened: 0, closed: 0 };

/**
 * One request's private state ("request-scoped service"): created after authorization, released
 * exactly once when the request is over. The counters prove cleanup under load.
 */
export class RequestLedger {
  readonly resource: ScaleResource;
  private released = false;
  private reads = 0;

  constructor(resource: ScaleResource) {
    this.resource = resource;
    counters.opened++;
  }

  read(): number {
    return ++this.reads;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    counters.closed++;
  }
}

export const ledgerStats = () => ({
  opened: counters.opened,
  closed: counters.closed,
  open: counters.opened - counters.closed,
});

export interface ScaleItem {
  readonly id: string;
  readonly resource: ScaleResource;
  readonly label: string;
}

export function findScaleItem(ledger: RequestLedger, id: string): ScaleItem | undefined {
  ledger.read();

  return id === "42" || id === "7"
    ? { id, resource: ledger.resource, label: `${ledger.resource.toUpperCase()} item ${id}` }
    : undefined;
}

export interface ItemInput {
  readonly name: string;
  readonly quantity: number;
}

/** A Standard Schema v1 validator, written out so that no validation library differs between arms. */
export const ITEM_INPUT: StandardSchemaV1<unknown, ItemInput> = {
  "~standard": {
    version: 1,
    vendor: "strata-perf",
    validate(value) {
      const input = value as Partial<ItemInput> | null;
      const issues: StandardSchemaV1.Issue[] = [];

      if (typeof input?.name !== "string" || input.name.length === 0 || input.name.length > 64)
        issues.push({ message: "name must be 1-64 characters", path: ["name"] });
      if (
        typeof input?.quantity !== "number" ||
        !Number.isInteger(input.quantity) ||
        input.quantity < 1
      )
        issues.push({ message: "quantity must be a positive integer", path: ["quantity"] });

      return issues.length > 0
        ? { issues }
        : { value: { name: input!.name!, quantity: input!.quantity! } };
    },
  },
};

export const scaleAnswer = (status: number, body: unknown, marker: string): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-perf-handler": marker,
    },
  });
