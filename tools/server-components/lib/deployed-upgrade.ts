import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { BrowserContext } from "playwright";

import { findFreePort } from "../../analog/lib/process.ts";

/**
 * The DEPLOYMENT-AWARE half of `pnpm test:full-stack-registry-upgrade-rollback`
 * (docs/research/m5-production-qualification.md): release A and release B are deployed in turn
 * to ONE stable origin (a Cloudflare Pages branch alias), each deployment also keeping its own
 * immutable URL. Stale client assets are the previous deployment's REAL files, fetched from its
 * immutable URL; nothing is rewritten.
 *
 * The same scenario runs against
 *   LOCAL REHEARSAL  two `wrangler pages dev` servers (immutable) and `AliasOrigin` (the alias), or
 *   DEPLOYED         `wrangler pages deploy` to the isolated qualification project (workflow_dispatch).
 * Only the second may be called DEPLOYED.
 */

/** The ONLY Pages project this scenario may deploy to. */
export const UPGRADE_DEPLOY_PROJECT = "strata-fullstack-qualification";

/** Projects that must never be touched, named so that a mistake is refused with a reason. */
export const FORBIDDEN_PROJECTS = ["strata-www", "strata-sc-qualification"] as const;

/** A Pages preview branch of the qualification project (never its production branch). */
export const DEFAULT_UPGRADE_BRANCH = "m5-upgrade-rollback";

/** Refusals for a deployment target; empty means this exact target is allowed. */
export function deployTargetProblems(target: { project: string; branch: string }): string[] {
  const problems: string[] = [];

  if ((FORBIDDEN_PROJECTS as readonly string[]).includes(target.project)) {
    problems.push(`"${target.project}" is a protected project and is never a qualification target`);
  }
  if (target.project !== UPGRADE_DEPLOY_PROJECT) {
    problems.push(`only "${UPGRADE_DEPLOY_PROJECT}" may be deployed to, not "${target.project}"`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,27}$/.test(target.branch)) {
    problems.push(
      `branch "${target.branch}" must be 1-28 lowercase letters, digits or dashes (its alias must be predictable)`,
    );
  }
  if (["main", "master", "production"].includes(target.branch)) {
    problems.push(`branch "${target.branch}" would be the production deployment`);
  }

  return problems;
}

/** The stable branch alias Pages serves the latest deployment of `branch` on. */
export const branchAliasUrl = (project: string, branch: string): string =>
  `https://${branch}.${project}.pages.dev`;

/** The stamp every Server Component boundary of a document carries (`data-strata-build`). */
export const buildStamps = (html: string): string[] =>
  [...html.matchAll(/data-strata-build="([^"]*)"/g)].map((match) => match[1]!);

/** True iff the document is a full SSR page of exactly this build. */
export const servesBuild = (html: string, buildId: string): boolean => {
  const stamps = buildStamps(html);

  return stamps.length > 0 && stamps.every((stamp) => stamp === buildId);
};

// ---------------------------------------------------------------------------
// Local stand-in for a branch alias

/**
 * An origin that forwards every request (documents, API, assets) to the CURRENT deployment,
 * like a Pages branch alias after `wrangler pages deploy`. Switching is atomic per request.
 * It never mixes releases on its own: stale assets come only from `staleAssets()`.
 */
export class AliasOrigin {
  baseUrl = "";
  private upstream = "";
  private server: Server | undefined;

  async start(): Promise<void> {
    const port = await findFreePort();

    this.server = createServer((request, response) => {
      void this.forward(request, response).catch((error: unknown) => {
        response.statusCode = 502;
        response.end(`alias failure: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /** "Deploys": every later request is answered by `upstream`. */
  point(upstream: string): void {
    this.upstream = upstream;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.upstream) {
      response.statusCode = 404;
      response.end("no deployment");

      return;
    }

    const chunks: Buffer[] = [];

    for await (const chunk of request) chunks.push(chunk as Buffer);

    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string" && !["host", "connection"].includes(name)) {
        headers[name] = value;
      }
    }

    const method = request.method ?? "GET";
    const upstream = await fetch(`${this.upstream}${request.url ?? "/"}`, {
      method,
      headers,
      redirect: "manual",
      ...(chunks.length > 0 && method !== "GET" && method !== "HEAD"
        ? { body: Buffer.concat(chunks) }
        : {}),
    });
    const out: Record<string, string | string[]> = {};

    upstream.headers.forEach((value, name) => {
      if (
        !["content-encoding", "content-length", "transfer-encoding", "set-cookie"].includes(name)
      ) {
        out[name] = value;
      }
    });
    // Each cookie stays its own header line, as an edge forwards them (never comma-joined).
    if (upstream.headers.getSetCookie().length > 0)
      out["set-cookie"] = upstream.headers.getSetCookie();
    response.writeHead(upstream.status, out);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }
}

// ---------------------------------------------------------------------------
// Stale client assets

export interface StaleAssets {
  /** Asset requests answered from the previous deployment. */
  readonly served: string[];
  /** Document requests seen by this context so far. */
  documents(): number;
  dispose(): Promise<void>;
}

/**
 * Serves `/assets/**` of `origin` from `previous` (the old deployment's immutable URL) to this
 * browser context — what a CDN or browser cache holding the old scripts does. With
 * `documents: 1` only the first document's assets are stale (the cache then converges); with
 * `"always"` the skew persists. The bytes are the previous deployment's real files.
 */
export async function staleAssets(
  context: BrowserContext,
  options: {
    readonly origin: string;
    readonly previous: string;
    readonly documents: 1 | "always";
  },
): Promise<StaleAssets> {
  const origin = new URL(options.origin);
  const served: string[] = [];
  let documents = 0;
  const onRequest = (request: { resourceType(): string; url(): string }): void => {
    if (request.resourceType() === "document" && new URL(request.url()).host === origin.host) {
      documents++;
    }
  };
  const matcher = (url: URL): boolean =>
    url.host === origin.host && url.pathname.startsWith("/assets/");

  context.on("request", onRequest);
  await context.route(matcher, async (route) => {
    if (options.documents !== "always" && documents > options.documents) {
      await route.continue();

      return;
    }

    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${options.previous}${url.pathname}${url.search}` });

    served.push(url.pathname);
    await route.fulfill({ response });
  });

  return {
    served,
    documents: () => documents,
    dispose: async () => {
      context.off("request", onRequest);
      await context.unroute(matcher);
    },
  };
}
