import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import { StrataAnalogHttpError, jsonResponse, noContent } from "@strata-sc/analog";
import type { StrataAnalogGuard, StrataAnalogRequest } from "@strata-sc/analog";
import { z } from "zod";

const tokens = new Map([
  ["fixture-token-ada", "ada"],
  ["fixture-token-grace", "grace"],
]);
const owners = new Map([
  ["ada-product", "ada"],
  ["grace-product", "grace"],
]);
const createProductSchema = z.object({
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
});
const updateProductSchema = z.object({
  status: z.enum(["active", "archived"]),
  name: z.string().trim().min(1).optional(),
});
const products = new Map([
  ["ada-product", { id: "ada-product", sku: "ADA-1", name: "Ada keyboard", status: "active" }],
  [
    "grace-product",
    { id: "grace-product", sku: "GRACE-1", name: "Grace monitor", status: "active" },
  ],
]);

/** Fixture-only route policy requiring a principal and enforcing resource ownership. */
export const inventoryGuard: StrataAnalogGuard = ({ request }) => {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const principal = tokens.get(token);
  if (!principal) return { allow: false, status: 401 };
  const resourceOwner = owners.get(request.params["id"] ?? "");
  if (resourceOwner !== undefined && resourceOwner !== principal) {
    return { allow: false, status: 403 };
  }
  return { allow: true };
};

@Controller("/api/products")
export class InventoryController {
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    const product = products.get(request.params["id"] ?? "");
    if (!product) throw new StrataAnalogHttpError(404, "not_found", "Product was not found.");
    return jsonResponse(product);
  }

  @Post()
  async create(request: StrataAnalogRequest) {
    const input = await request.readValidatedJson(createProductSchema);
    if ([...products.values()].some((product) => product.sku === input.sku)) {
      throw new StrataAnalogHttpError(409, "conflict", "A product with this SKU already exists.");
    }
    const product = {
      id: `fixture-${input.sku.toLowerCase()}`,
      ...input,
      status: "active" as const,
    };
    products.set(product.id, product);
    const token = request.headers.get("authorization")?.slice("Bearer ".length) ?? "";
    const principal = tokens.get(token);
    if (principal) owners.set(product.id, principal);
    return jsonResponse(product, { status: 201, headers: { "x-fixture-contract": "inventory" } });
  }

  @Patch("/:id")
  async update(request: StrataAnalogRequest) {
    const product = products.get(request.params["id"] ?? "");
    if (!product) throw new StrataAnalogHttpError(404, "not_found");
    const input = await request.readValidatedJson(updateProductSchema);
    if (input.status === "archived") {
      throw new StrataAnalogHttpError(
        422,
        "invalid_product_state",
        "Business state cannot be archived.",
      );
    }
    const updated = { ...product, ...input };
    products.set(product.id, updated);
    return jsonResponse(updated);
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    const id = request.params["id"] ?? "";
    if (!products.has(id)) throw new StrataAnalogHttpError(404, "not_found");
    products.delete(id);
    owners.delete(id);
    return noContent({ headers: { "x-deleted-product": id } });
  }
}
