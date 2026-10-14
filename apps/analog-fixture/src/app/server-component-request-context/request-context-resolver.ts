import type { RequestContextFixtureValue, RequestContextIdentity } from "./request-context-types";

export class RequestContextResolutionError extends Error {
  constructor(
    readonly code:
      "missing-context" | "unknown-identity" | "malformed-identity" | "mismatched-resource",
  ) {
    super(`request context rejected: ${code}`);
    this.name = "RequestContextResolutionError";
  }
}

const isIdentity = (value: string): value is RequestContextIdentity =>
  value === "alpha" || value === "beta";

export function resolveRequestContext(url: string): RequestContextFixtureValue | null {
  const parsed = new URL(url, "http://localhost");

  if (!parsed.pathname.startsWith("/server-component-request-context/")) return null;
  if (parsed.searchParams.has("missing")) {
    throw new RequestContextResolutionError("missing-context");
  }

  const encodedIdentity = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!encodedIdentity) throw new RequestContextResolutionError("missing-context");

  let routeIdentity: string;
  try {
    routeIdentity = decodeURIComponent(encodedIdentity);
  } catch {
    throw new RequestContextResolutionError("malformed-identity");
  }
  if (routeIdentity.trim() !== routeIdentity) {
    throw new RequestContextResolutionError("malformed-identity");
  }
  if (!isIdentity(routeIdentity)) {
    throw new RequestContextResolutionError("unknown-identity");
  }

  const requestedResource = parsed.searchParams.get("resource");
  if (requestedResource !== null) {
    if (requestedResource.trim() !== requestedResource || !isIdentity(requestedResource)) {
      throw new RequestContextResolutionError("malformed-identity");
    }
    if (requestedResource !== routeIdentity) {
      throw new RequestContextResolutionError("mismatched-resource");
    }
  }

  return {
    id: routeIdentity,
    round: parsed.searchParams.get("round") ?? "default",
    operation: parsed.searchParams.get("fail") === "true" ? "fail" : "read",
  };
}
