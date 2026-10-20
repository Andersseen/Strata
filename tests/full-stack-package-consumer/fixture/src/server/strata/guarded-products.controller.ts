import { Controller, Delete, Get, Post } from "@strata-sc/core";
import type { StrataAnalogGuard, StrataAnalogRequest } from "@strata-sc/analog";

const syntheticTokens = new Map([
  ["opaque-ada", "ada"],
  ["opaque-grace", "grace"],
]);
const syntheticOwners = new Map([
  ["ada-item", "ada"],
  ["grace-item", "grace"],
]);

export const syntheticAuthorizationGuard: StrataAnalogGuard = ({ request, route }) => {
  if (route.method === "GET") return { allow: true };
  const header = request.headers.get("authorization");
  const principal = header?.startsWith("Bearer ")
    ? syntheticTokens.get(header.slice("Bearer ".length))
    : undefined;
  if (!principal) return { allow: false, status: 401 };
  if (route.method === "DELETE" && syntheticOwners.get(request.params["id"] ?? "") !== principal) {
    return { allow: false, status: 403 };
  }
  return { allow: true };
};

@Controller("/api/guarded-products")
export class GuardedProductsController {
  @Get("/:id")
  read(request: StrataAnalogRequest) {
    return { id: request.params["id"], visibility: "public" };
  }

  @Post()
  create() {
    return { created: true };
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    return { removed: request.params["id"] };
  }
}
