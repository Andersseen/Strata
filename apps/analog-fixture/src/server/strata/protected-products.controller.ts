import { Controller, Delete, Get, Post } from "@strata-sc/core";
import type { StrataAnalogGuard, StrataAnalogRequest } from "@strata-sc/analog";

const tokens = new Map([
  ["fixture-token-ada", "ada"],
  ["fixture-token-grace", "grace"],
]);
const owners = new Map([
  ["ada-product", "ada"],
  ["grace-product", "grace"],
]);

/** Synthetic consumer-owned verifier and route policy for integration coverage. */
export const protectedProductsGuard: StrataAnalogGuard = ({ request, route }) => {
  if (route.method === "GET") return { allow: true };

  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const principal = tokens.get(token);
  if (!principal) return { allow: false, status: 401 };
  if (route.method === "DELETE" && owners.get(request.params["id"] ?? "") !== principal) {
    return { allow: false, status: 403 };
  }
  return { allow: true };
};

@Controller("/api/protected-products")
export class ProtectedProductsController {
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    return { id: request.params["id"], public: true };
  }

  @Post()
  create() {
    return { created: true };
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    return { deleted: request.params["id"] };
  }
}
