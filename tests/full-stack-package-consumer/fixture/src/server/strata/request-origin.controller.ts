import { Controller, Get, Post } from "@strata-sc/core";
import type { StrataAnalogGuard, StrataAnalogRequest } from "@strata-sc/analog";

/**
 * S-1 request URL integrity from the INSTALLED @strata-sc/analog (0.13.0 and later), on every
 * runtime the full-stack consumer runs on (docs/research/rc0-production-requalification.md).
 *
 * - `/api/request-origin/pinned/*` is registered with `publicOrigin`, the only trusted deployment
 *   origin. Its POST is a consumer-owned same-origin guard, the pattern the package README shows.
 * - `/api/request-origin/transport/*` is registered without it, so its origin is transport
 *   information: what the runtime received, never a forwarded header, and `strata.invalid` when no
 *   usable origin exists.
 *
 * Both echo what `request.url` holds so the runner can compare it with what it sent. Nothing here is
 * a secret: the echo is bounded to the URL the request itself carried.
 */
export const PINNED_ORIGIN = "https://consumer.strata-qualification.example";

const describeRequest = (scope: string, request: StrataAnalogRequest): Response =>
  new Response(
    JSON.stringify({
      scope,
      origin: request.url.origin,
      pathname: request.url.pathname,
      search: request.url.search,
      path: request.path,
      query: request.query,
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );

@Controller("/api/request-origin/pinned")
export class PinnedOriginController {
  @Get("/echo")
  echo(request: StrataAnalogRequest) {
    return describeRequest("pinned", request);
  }

  @Post("/mutate")
  mutate() {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
}

@Controller("/api/request-origin/transport")
export class TransportOriginController {
  @Get("/echo")
  echo(request: StrataAnalogRequest) {
    return describeRequest("transport", request);
  }
}

/** Consumer-owned: a state-changing request must come from the deployment's own origin. */
export const sameOriginGuard: StrataAnalogGuard = ({ request }) =>
  request.method === "GET" || request.headers.get("origin") === request.url.origin
    ? { allow: true }
    : { allow: false, status: 403 };
