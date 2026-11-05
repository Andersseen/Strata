import { DestroyRef, inject } from "@angular/core";
import { StrataAnalogHttpError } from "@strata-sc/analog";
import type { StrataAnalogRequest } from "@strata-sc/analog";
import { Controller, Get, Post } from "@strata-sc/core";

import {
  COMPOSITION_AUDIT_SINK,
  COMPOSITION_MARKER,
  COMPOSITION_PRIVATE_CANARY,
  COMPOSITION_REQUEST,
  CompositionCatalog,
  CompositionIdentity,
  compositionStats,
  rendezvous,
  step,
} from "./composition.providers";

type Issues = { readonly issues: readonly { readonly message: string }[] };

/**
 * A consumer-written Standard Schema v1 object: no validator library, no import of the spec
 * package. It must satisfy the installed `@strata-sc/analog` declarations structurally.
 */
function schema<Output>(
  validate: (
    value: unknown,
  ) => { readonly value: Output } | Issues | Promise<{ readonly value: Output } | Issues>,
) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "packed-consumer",
      validate,
      types: undefined as unknown as { readonly input: unknown; readonly output: Output },
    },
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const invalid: Issues = { issues: [{ message: "invalid" }] };

/** Synchronous: a numeric route id. */
export const paramsSchema = schema<{ id: number }>((value) => {
  const id = record(value)["id"];
  return typeof id === "string" && /^\d{1,6}$/.test(id) ? { value: { id: Number(id) } } : invalid;
});

/** Asynchronous: a required lowercase tag, transformed to upper case. */
export const querySchema = schema<{ tag: string }>(async (value) => {
  await Promise.resolve();
  const tag = record(value)["tag"];
  return typeof tag === "string" && /^[a-z0-9]{1,16}$/.test(tag)
    ? { value: { tag: tag.toUpperCase() } }
    : invalid;
});

/** A JSON body whose `count` is coerced from a numeric string. */
export const bodySchema = schema<{ count: number }>((value) => {
  const count = record(value)["count"];
  return typeof count === "string" && /^\d{1,4}$/.test(count)
    ? { value: { count: Number(count) } }
    : invalid;
});

/**
 * Request-scoped through the consumer's controllerFactory: every dependency is resolved by
 * `inject()` in field initializers inside the injection context the factory opens.
 */
@Controller("/api/packed-composition")
export class PackedCompositionController {
  static readonly serverOnlyMarker = COMPOSITION_MARKER;

  private readonly catalog = inject(CompositionCatalog);
  private readonly identity = inject(CompositionIdentity);
  private readonly injectedRequest = inject(COMPOSITION_REQUEST);
  private readonly audit = inject(COMPOSITION_AUDIT_SINK);
  private destroyed = false;

  constructor() {
    step(this.injectedRequest, "construct");
    compositionStats.controllersConstructed++;
    if (this.injectedRequest.query["fail"] === "constructor") {
      throw new Error(`controller construction failed ${COMPOSITION_PRIVATE_CANARY}`);
    }
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      compositionStats.controllersDestroyed++;
    });
  }

  @Get("/products/:id")
  async read(request: StrataAnalogRequest) {
    step(request, "handler");
    compositionStats.handlerCalls++;
    const params = await request.validateParams(paramsSchema);
    const query = await request.validateQuery(querySchema);
    const meet = request.query["meet"];
    const met = typeof meet === "string" ? await rendezvous(meet, 8) : null;
    const fail = request.query["fail"];

    if (fail === "handler") throw new Error(`handler failed ${COMPOSITION_PRIVATE_CANARY}`);
    if (fail === "not-found") {
      throw new StrataAnalogHttpError(404, "not_found", `missing ${COMPOSITION_PRIVATE_CANARY}`);
    }
    if (request.query["native"] === "true") {
      return new Response("packed-native-preserved", {
        headers: { "content-type": "text/plain; charset=utf-8", "x-packed-native": "yes" },
      });
    }
    await Promise.resolve();
    return this.view(request, { product: this.catalog.product(params.id), tag: query.tag, met });
  }

  @Post("/products/:id")
  async create(request: StrataAnalogRequest) {
    step(request, "handler");
    compositionStats.handlerCalls++;
    const params = await request.validateParams(paramsSchema);
    const body = await request.readValidatedJson(bodySchema);
    await Promise.resolve();
    return this.view(request, { product: this.catalog.product(params.id), count: body.count });
  }

  private view(request: StrataAnalogRequest, data: Record<string, unknown>) {
    return {
      ...data,
      principal: this.identity.principal,
      identity: this.identity.id,
      catalogInstance: this.catalog.instance,
      audit: this.audit,
      capturedAfterAwait: this.identity.request === request && this.injectedRequest === request,
      destroyedBeforeResponse: this.destroyed,
    };
  }
}
