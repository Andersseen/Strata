import { Controller, Get, Post } from "@strata-sc/core";
import type { StrataAnalogGuard, StrataAnalogRequest } from "@strata-sc/analog";

/**
 * S-1 (docs/research/pre-rc0-consolidation.md): what `request.url` reports on each runtime.
 * `pnpm test:analog-headers` reads these on the Nitro node-server build, the Vite dev server and
 * local workerd.
 */
function describe(request: StrataAnalogRequest) {
  return {
    href: request.url.href,
    origin: request.url.origin,
    path: request.path,
    search: request.url.search,
    query: request.query,
  };
}

/** Registered without `publicOrigin`: the transport URL. */
@Controller("/api/strata/url/transport")
export class TransportUrlController {
  @Get("/")
  read(request: StrataAnalogRequest) {
    return describe(request);
  }
}

/** Registered with `publicOrigin`, behind the consumer-owned check below. */
@Controller("/api/strata/url/public")
export class PublicUrlController {
  @Get("/")
  read(request: StrataAnalogRequest) {
    return describe(request);
  }

  @Post("/submit")
  submit() {
    return { accepted: true };
  }
}

export const FIXTURE_PUBLIC_ORIGIN = "https://app.strata.test";

/** A consumer's origin check: state-changing requests must come from the public origin. */
export const sameOriginGuard: StrataAnalogGuard = ({ request }) =>
  request.method === "GET" || request.headers.get("origin") === request.url.origin
    ? { allow: true }
    : { allow: false, status: 403 };
