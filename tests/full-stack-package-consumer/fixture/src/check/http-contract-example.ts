import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import {
  StrataAnalogHttpError,
  jsonResponse,
  noContent,
  registerControllers,
} from "@strata-sc/analog";
import type {
  NitroRouter,
  StrataAnalogGuard,
  StrataAnalogInterceptor,
  StrataAnalogRequest,
} from "@strata-sc/analog";
import { z } from "zod";

const products = new Map<number, { id: number; name: string; status: "active" | "archived" }>([
  [1, { id: 1, name: "Keyboard", status: "active" }],
]);
const owners = new Map<number, string>([[1, "ada"]]);
const tokens = new Map<string, string>([["fixture-token", "ada"]]);
const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const querySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
const createSchema = z.object({ name: z.string().trim().min(1) });
const patchSchema = z.object({ name: z.string().trim().min(1) });
let nextId = 2;
const durations: number[] = [];

@Controller("/api/example-products")
class ProductsController {
  @Get("/:id")
  async get(request: StrataAnalogRequest) {
    const { id } = await request.validateParams(paramsSchema);
    const { includeArchived } = await request.validateQuery(querySchema);
    const product = products.get(id);
    if (!product || (product.status === "archived" && !includeArchived)) {
      throw new StrataAnalogHttpError(404, "not_found");
    }
    return jsonResponse(product);
  }

  @Post()
  async post(request: StrataAnalogRequest) {
    const input = await request.readValidatedJson(createSchema);
    if ([...products.values()].some((product) => product.name === input.name)) {
      throw new StrataAnalogHttpError(409, "conflict");
    }
    const product = { id: nextId++, name: input.name, status: "active" as const };
    products.set(product.id, product);
    owners.set(product.id, "ada");
    return jsonResponse(product, { status: 201, headers: { "cache-control": "no-store" } });
  }

  @Patch("/:id")
  async patch(request: StrataAnalogRequest) {
    const { id } = await request.validateParams(paramsSchema);
    const input = await request.readValidatedJson(patchSchema);
    const product = products.get(id);
    if (!product) throw new StrataAnalogHttpError(404, "not_found");
    if (product.status !== "active") {
      throw new StrataAnalogHttpError(422, "invalid_product_state");
    }
    const updated = { ...product, name: input.name };
    products.set(id, updated);
    return jsonResponse(updated);
  }

  @Delete("/:id")
  async delete(request: StrataAnalogRequest) {
    const { id } = await request.validateParams(paramsSchema);
    if (!products.delete(id)) throw new StrataAnalogHttpError(404, "not_found");
    owners.delete(id);
    return noContent();
  }
}

const requireOwner: StrataAnalogGuard = ({ request }) => {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const principal = tokens.get(token);
  if (!principal) return { allow: false, status: 401 };
  const rawId = request.params["id"];
  const owner = rawId === undefined ? undefined : owners.get(Number(rawId));
  if (owner !== undefined && owner !== principal) return { allow: false, status: 403 };
  return { allow: true };
};

const timing: StrataAnalogInterceptor = async (_context, next) => {
  const started = performance.now();
  try {
    return await next();
  } finally {
    durations.push(performance.now() - started);
  }
};

export function registerExample(router: NitroRouter): NitroRouter {
  return registerControllers(router, [ProductsController], {
    guards: [requireOwner],
    interceptors: [timing],
  });
}
