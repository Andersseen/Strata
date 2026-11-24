import { StrataAnalogConfigurationError } from "./errors.js";

/**
 * The origin `request.url` carries when neither the consumer's `publicOrigin` nor the runtime gives
 * one. `.invalid` is reserved (RFC 6761): no browser document can have this origin, so a same-origin
 * comparison against it fails closed instead of matching a real site, as `http://localhost` could.
 */
export const UNKNOWN_ORIGIN = "http://strata.invalid";

/** The parts of Nitro/H3's v1 event the URL is derived from. Declared structurally, like the rest. */
export interface RequestUrlSource {
  readonly path?: string;
  readonly context?: Record<string, unknown>;
  readonly web?: {
    readonly request?: { readonly url?: string };
    readonly url?: URL;
  };
  readonly node?: {
    readonly req?: {
      readonly url?: string | undefined;
      readonly originalUrl?: string;
      readonly headers?: Record<string, string | readonly string[] | undefined>;
      // Not declared on the public `NitroEvent`: read structurally, see nodeTransportOrigin().
    };
  };
}

/**
 * Validates `registerControllers()`'s `publicOrigin`: an absolute `http:` or `https:` origin with
 * nothing after it but an optional `/`. Returns the serialized origin.
 */
export function parsePublicOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;

  const invalid = () =>
    new StrataAnalogConfigurationError(
      "registerControllers() option `publicOrigin` must be an absolute http(s) origin such as " +
        '"https://app.example.com", without credentials, path, query or fragment.',
    );

  if (typeof value !== "string") throw invalid();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.href !== `${url.origin}/` ||
    !(value === url.origin || value === url.href)
  ) {
    throw invalid();
  }

  return url.origin;
}

/**
 * `request.url` for one invocation.
 *
 * - Path and query are always the request target's, exactly as routed. An absolute-form target
 *   (`GET http://other.example/x`) or one starting with `//` contributes its path only and can never
 *   replace the origin.
 * - The origin is, in order: the consumer's `publicOrigin` (the only trusted one); the absolute URL
 *   the runtime itself received (Cloudflare's `request.url`, H3's web adapter); on Node, the
 *   syntax-checked `Host` header with the scheme of the actual socket. `X-Forwarded-*` is never
 *   read. When none of these is available, {@link UNKNOWN_ORIGIN}.
 *
 * Only `publicOrigin` is deployment identity. Every other origin is transport information that the
 * client or an intermediary chose, see the package README.
 */
export function resolveRequestUrl(event: RequestUrlSource, publicOrigin: string | undefined): URL {
  const platform = platformUrl(event);
  const target =
    event.path ??
    event.node?.req?.originalUrl ??
    event.node?.req?.url ??
    (platform ? platform.pathname + platform.search : "/");
  const origin = publicOrigin ?? platform?.origin ?? nodeTransportOrigin(event) ?? UNKNOWN_ORIGIN;
  const url = new URL(`${origin}${pathAndQuery(target)}`);

  url.hash = "";

  // The origin is serialized first, so the target cannot move it; this keeps that a checked fact.
  return url.origin === origin ? url : new URL(`${UNKNOWN_ORIGIN}${url.pathname}${url.search}`);
}

function pathAndQuery(target: string): string {
  if (target.startsWith("/")) return target;

  if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
    try {
      const absolute = new URL(target);
      return `${absolute.pathname}${absolute.search}`;
    } catch {
      return "/";
    }
  }

  return `/${target}`;
}

/** The absolute URL the runtime received, when it exposes one. */
function platformUrl(event: RequestUrlSource): URL | undefined {
  const cloudflare = event.context?.["cloudflare"];
  const candidates: unknown[] = [
    event.web?.url?.href,
    event.web?.request?.url,
    // Nitro's documented Cloudflare context: the Request the Worker received.
    typeof cloudflare === "object" && cloudflare !== null
      ? (cloudflare as { request?: { url?: unknown } }).request?.url
      : undefined,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") return url;
    } catch {
      // Not a URL: try the next source.
    }
  }

  return undefined;
}

/** A host, IPv4 or bracketed IPv6 literal, and an optional port: nothing a URL could re-parse. */
const HOST_HEADER = /^(?:\[[\da-f:.]+\]|[a-z\d](?:[a-z\d.-]{0,252}[a-z\d])?)(?::\d{1,5})?$/i;

function nodeTransportOrigin(event: RequestUrlSource): string | undefined {
  const request = event.node?.req;
  const host = request?.headers?.["host"];

  if (typeof host !== "string" || !HOST_HEADER.test(host)) return undefined;

  try {
    // Whether the connection itself is TLS, the only scheme input on Node: `encrypted` is
    // `true` on a `tls.TLSSocket` and absent on a plain `net.Socket`.
    const socket: unknown = (request as { readonly socket?: unknown } | undefined)?.socket;
    const encrypted =
      typeof socket === "object" &&
      socket !== null &&
      (socket as { readonly encrypted?: unknown }).encrypted === true;
    const scheme = encrypted ? "https" : "http";
    const url = new URL(`${scheme}://${host}`);

    return url.username === "" && url.password === "" && url.pathname === "/"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}
