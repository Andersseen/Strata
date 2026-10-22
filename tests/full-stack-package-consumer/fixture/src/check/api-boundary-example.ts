import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import {
  StrataAnalogHttpError,
  jsonResponse,
  noContent,
  registerControllers,
} from "@strata-sc/analog";
import type {
  NitroRouter,
  RegisterControllersOptions,
  StrataAnalogApiBoundaryOptions,
  StrataAnalogGuard,
  StrataAnalogNativeRoute,
  StrataAnalogRequest,
} from "@strata-sc/analog";

// A complete consumer of the HTTP routing and API boundary contract
// (docs/research/analog-http-routing-v06.md), compiled with strict TypeScript and
// `skipLibCheck: false` against the PACKED declarations. No H3 or Nitro type is needed.

const products = new Map([["42", { id: "42", name: "Keyboard" }]]);

@Controller("/api/products")
class ProductsController {
  @Get("/:id")
  find(request: StrataAnalogRequest) {
    const product = products.get(request.params["id"] ?? "");
    if (!product) throw new StrataAnalogHttpError(404, "not_found");
    return jsonResponse(product);
  }

  @Post()
  create() {
    return jsonResponse({ id: "43", name: "Mouse" }, { status: 201 });
  }

  @Patch("/:id")
  update(request: StrataAnalogRequest) {
    return jsonResponse({ id: request.params["id"], name: "Renamed" });
  }

  @Delete("/:id")
  remove() {
    return noContent();
  }
}

@Controller("/api/orders")
class OrdersController {
  @Get()
  list() {
    return [{ id: "o1" }];
  }
}

/** Fixture-only policy: every route of the protected controller needs a bearer token. */
const requireToken: StrataAnalogGuard = ({ request }) =>
  request.headers.get("authorization")?.startsWith("Bearer ")
    ? { allow: true }
    : { allow: false, status: 401 };

/** The native Nitro route (`src/server/routes/api/health.get.ts`) the boundary should know about. */
const health: StrataAnalogNativeRoute = { path: "/api/health", methods: ["GET"] };

const apiBoundary: StrataAnalogApiBoundaryOptions = {
  prefixes: ["/api"],
  nativeRoutes: [health],
  head: "derive",
  options: "allow",
};

const publicOptions: RegisterControllersOptions = { apiBoundary };

export function registerApi(router: NitroRouter): NitroRouter {
  // The first call declares the owned namespace; later calls only add routes to it.
  registerControllers(router, [OrdersController], publicOptions);

  return registerControllers(router, [ProductsController], { guards: [requireToken] });
}
