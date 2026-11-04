import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogGuard, StrataAnalogRequest } from "@strata-sc/analog";

import {
  authorize,
  protectedReads,
  readProtectedResource,
  resolveTenant,
  requestedTenant,
} from "./tenant-authorization";

const ownerForId = (id: string) =>
  id === "alpha-product" ? "alpha" : id === "beta-product" ? "beta" : null;

export const protectedControllerGuard: StrataAnalogGuard = ({ request }) => {
  const id = request.params["id"] ?? "";
  const owner = ownerForId(id);
  const requested = requestedTenant(request.params["tenant"] ?? "");
  // Unknown and malformed resource selectors reach the safe handler 404 without a read.
  if (!owner || requested !== owner) return { allow: true };
  const status = authorize(resolveTenant(request.headers), owner);
  return status === 200 ? { allow: true } : { allow: false, status };
};

@Controller("/api/protected/:tenant/products")
export class ProtectedProductsController {
  @Get("/:id")
  read(request: StrataAnalogRequest) {
    const id = request.params["id"] ?? "";
    if (!ownerForId(id) || requestedTenant(request.params["tenant"] ?? "") !== ownerForId(id)) {
      return new Response('{"error":"not_found"}', {
        status: 404,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    }
    const resource = readProtectedResource(id);
    // The guard guarantees the owner relationship before the private read.
    if (!resource)
      return new Response('{"error":"not_found"}', {
        status: 404,
        headers: { "cache-control": "no-store", "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ tenant: resource.tenant, label: resource.label }), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-fixture-protected-read": "1",
      },
    });
  }
}
