import { DestroyRef, inject } from "@angular/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";
import { Controller, Get, Post } from "@strata-sc/core";

import {
  CatalogService,
  compositionStats,
  REQUEST_CONFIGURATION,
  RequestAudit,
  RequestIdentity,
  STRATA_ANALOG_ANGULAR_DI_MARKER,
  STRATA_REQUEST,
  angularDiStats,
} from "./providers";
import { rendezvous } from "./rendezvous";
import { bodySchema, paramsSchema, protectedQuerySchema } from "../validation.controller";

/** Long enough never to expire when two requests really overlap. */
const RENDEZVOUS_TIMEOUT_MS = 5_000;

/**
 * Dependencies are resolved with `inject()` in field initializers, inside the
 * injection context the controller factory opens, and kept across `await`.
 * The explicit HTTP input still arrives as the `StrataAnalogRequest` argument.
 */
@Controller("/api/strata/angular-di")
export class CatalogController {
  static readonly serverOnlyMarker = STRATA_ANALOG_ANGULAR_DI_MARKER;

  private readonly catalog = inject(CatalogService);
  private readonly identity = inject(RequestIdentity);
  private readonly audit = inject(RequestAudit);
  private readonly injectedRequest = inject(STRATA_REQUEST);
  private readonly requestConfiguration = inject(REQUEST_CONFIGURATION);
  private destroyed = false;

  constructor() {
    compositionStats.controllerConstructions++;
    if (this.injectedRequest.query["constructFailure"] === "true") {
      throw new Error("Request failed.");
    }
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      angularDiStats.controllersReleased++;
    });
  }

  @Get("/products/:id")
  async findOne(request: StrataAnalogRequest) {
    compositionStats.handlerCalls++;
    const id = request.params["id"] ?? "";
    const meet = request.query["meet"];
    const injectInHandler = describeInject();

    // With `?meet=<key>`, `met` is true only if a second request with the same
    // key was suspended here too: both controllers were alive at once.
    const met = typeof meet === "string" ? await rendezvous(meet, 2, RENDEZVOUS_TIMEOUT_MS) : null;

    return {
      met,
      product: this.catalog.findProduct(id),
      catalogInstance: this.catalog.instance,
      identity: this.identity.id,
      identityProductId: this.identity.productId,
      auditSharesIdentity: this.audit.identity === this.identity,
      injectedRequestIsArgument: this.injectedRequest === request,
      injectInHandler,
      injectAfterAwait: describeInject(),
      destroyedBeforeResponse: this.destroyed,
    };
  }

  /** Throws synchronously: the handler is not `async`. */
  @Get("/fail/throw")
  failThrow(): never {
    compositionStats.handlerCalls++;
    throw new Error(`thrown by request ${String(this.identity.id)}`);
  }

  /** Rejects after an `await`, i.e. after the injection context has been left. */
  @Get("/fail/reject")
  async failReject(): Promise<never> {
    compositionStats.handlerCalls++;
    await Promise.resolve();

    throw new Error(`rejected by request ${String(this.identity.id)}`);
  }

  /** Guarded route composing verified identity, validation and Angular DI. */
  @Get("/protected/products/:id")
  async findProtected(request: StrataAnalogRequest) {
    compositionStats.handlerCalls++;
    const params = await request.validateParams(paramsSchema);
    const query = await request.validateQuery(protectedQuerySchema);
    const meet = request.query["meet"];
    const met = typeof meet === "string" ? await rendezvous(meet, 8, RENDEZVOUS_TIMEOUT_MS) : null;
    if (request.query["handlerFailure"] === "sync") throw new Error("Request failed.");
    if (request.query["handlerFailure"] === "async") {
      await Promise.resolve();
      throw new Error("Request failed.");
    }
    if (request.query["nativeResponse"] === "true") {
      return new Response("native-response-preserved", { headers: { "x-fixture-native": "yes" } });
    }
    await Promise.resolve();
    return {
      product: this.catalog.findProduct(String(params.id)),
      tag: query.tag,
      met,
      principal: this.identity.principal,
      identity: this.identity.id,
      identityProductId: this.identity.productId,
      auditSharesIdentity: this.audit.identity === this.identity,
      injectedRequestIsArgument: this.injectedRequest === request,
      configuration: this.requestConfiguration,
      destroyedBeforeResponse: this.destroyed,
    };
  }

  /** Guarded JSON route exercises the same injector through async body validation. */
  @Post("/protected/products/:id")
  async createProtected(request: StrataAnalogRequest) {
    compositionStats.handlerCalls++;
    const params = await request.validateParams(paramsSchema);
    const body = await request.readValidatedJson(bodySchema);
    await Promise.resolve();
    return {
      id: params.id,
      count: body.count,
      principal: this.identity.principal,
      identity: this.identity.id,
      identityProductId: this.identity.productId,
      auditSharesIdentity: this.audit.identity === this.identity,
      injectedRequestIsArgument: this.injectedRequest === request,
      configuration: this.requestConfiguration,
      destroyedBeforeResponse: this.destroyed,
    };
  }
}

/**
 * Calls `inject()` from a handler body. Angular's injection context is
 * synchronous: it ended when the factory's `runInInjectionContext()` returned,
 * before Strata called the handler, so this must fail with NG0203 — both before
 * and after the handler's first `await` — instead of resolving anything.
 */
function describeInject(): string {
  try {
    inject(RequestIdentity);

    return "resolved";
  } catch (error) {
    return /NG0203/.exec(String(error))?.[0] ?? `unexpected: ${String(error)}`;
  }
}
