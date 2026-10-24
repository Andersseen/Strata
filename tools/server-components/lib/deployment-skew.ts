import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { findFreePort } from "../../analog/lib/process.ts";
import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";
import type { CommandResult } from "../../consumer/lib/exec.ts";

import { isolatedEnv } from "./package-consumer.ts";

/**
 * Helpers of `pnpm test:server-component-deployment-skew`
 * (docs/research/server-component-deployment-skew-v08.md): two (or three)
 * independently built releases of one external consumer, and an "edge" that
 * serves a document from one release and its scripts from another, the way a
 * CDN, a cache or a rolling deployment does. Private to the repo.
 */

export type Release = "a" | "b" | "legacy";

/** What each release is, so a scenario can say which one it expects to have served a page. */
export const RELEASES: Readonly<
  Record<
    Release,
    { readonly buildId: string | undefined; readonly message: string; readonly renamed: boolean }
  >
> = {
  a: { buildId: "rel-2026.10.1", message: "External server A", renamed: false },
  b: { buildId: "rel-2026.10.2", message: "External server B", renamed: true },
  // The same sources as `a`, built without the option: the application that never opted in.
  legacy: { buildId: undefined, message: "External server A", renamed: false },
};

export const sanitize = (text: string): string => stripVTControlCharacters(text);

/**
 * Release B changes the application's component contract and nothing about the
 * protocol: the client island's input is renamed (`product` → `item`), and the
 * server message changes. Every replacement must apply, or the build is not a
 * different release.
 */
export function applyReleaseB(consumerDir: string): void {
  const edit = (file: string, replacements: readonly (readonly [string, string])[]): void => {
    const path = join(consumerDir, "src", "app", "product", file);
    let text = readFileSync(path, "utf8");

    for (const [from, to] of replacements) {
      if (!text.includes(from)) throw new Error(`release B: ${file} no longer contains ${from}`);
      text = text.split(from).join(to);
    }
    writeFileSync(path, text);
  };

  edit("add-to-cart.component.ts", [
    ["product().", "item()."],
    ["readonly product = input", "readonly item = input"],
  ]);
  edit("product-details.server-component.ts", [
    [
      '<add-to-cart [product]="publicProduct" [strataClient]="{ product: publicProduct }" />',
      '<add-to-cart [item]="publicProduct" [strataClient]="{ item: publicProduct }" />',
    ],
    ["External server A", "External server B"],
  ]);
}

export interface BuiltRelease {
  readonly release: Release;
  /** A directory holding `dist/` and a `node_modules` link, enough to run it. */
  readonly directory: string;
  readonly output: string;
}

export function buildRelease(options: {
  readonly consumerDir: string;
  readonly releasesDir: string;
  readonly release: Release;
  readonly preset: "node" | "cloudflare";
  readonly env: NodeJS.ProcessEnv;
}): BuiltRelease {
  const { consumerDir, releasesDir, release, preset, env } = options;
  const source = join(consumerDir, "src");
  const pristine = join(releasesDir, "pristine-src");

  // Every release starts from the same authored sources.
  if (!existsSync(pristine)) cpSync(source, pristine, { recursive: true });
  rmSync(source, { recursive: true, force: true });
  cpSync(pristine, source, { recursive: true });
  for (const dir of ["dist", ".nitro", ".angular"]) {
    rmSync(join(consumerDir, dir), { recursive: true, force: true });
  }
  if (release === "b") applyReleaseB(consumerDir);

  const buildId = RELEASES[release].buildId;
  const result: CommandResult = run(
    process.execPath,
    [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"],
    {
      cwd: consumerDir,
      env: {
        ...env,
        STRATA_STABLE_ENTRY: "1",
        ...(buildId === undefined ? {} : { STRATA_BUILD_ID: buildId }),
        ...(preset === "cloudflare" ? { BUILD_PRESET: "cloudflare-pages" } : {}),
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `build of release ${release} (${preset}) failed:\n${sanitize(result.stderr || result.stdout).slice(-3000)}`,
    );
  }

  const directory = join(releasesDir, `${preset}-${release}`);

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  cpSync(join(consumerDir, "dist"), join(directory, "dist"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  symlinkSync(join(consumerDir, "node_modules"), join(directory, "node_modules"), "dir");

  return { release, directory, output: sanitize(result.stdout) };
}

/** Every file under `roots` (relative to `base`) containing any of `needles`. */
export function filesContaining(
  base: string,
  roots: readonly string[],
  needles: readonly string[],
): string[] {
  const found: string[] = [];

  for (const root of roots) {
    const directory = join(base, root);

    if (!existsSync(directory)) continue;
    for (const file of listFiles(directory)) {
      const text = readFileSync(join(directory, file), "utf8");

      if (needles.some((needle) => text.includes(needle))) found.push(join(root, file));
    }
  }

  return found;
}

export const isolated = (tmpRoot: string): NodeJS.ProcessEnv => {
  const user = join(tmpRoot, "empty.npmrc");
  const global = join(tmpRoot, "empty-global.npmrc");

  writeFileSync(user, "");
  writeFileSync(global, "");

  return isolatedEnv(user, global);
};

// ---------------------------------------------------------------------------
// The edge

/** Which release answers the document and which release's scripts the browser then loads. */
export interface Plan {
  readonly html: Release;
  readonly assets: Release;
}

export interface DocumentRequest {
  readonly path: string;
  readonly plan: Plan;
}

/** A change applied to a real document before it is served; every use is a labelled negative control. */
export type Rewrite = (html: string) => string;

export interface EdgeOptions {
  readonly upstreams: Readonly<Record<Release, string>>;
}

/**
 * A reverse proxy in front of the real servers of several releases. A document
 * request is answered by `plan.html`'s server; every asset is looked up in
 * `plan.assets`' server first and then in `plan.html`'s, as when both releases'
 * files are on the CDN. The fixture is built with a STABLE entry URL
 * (`/assets/entry.js`), so the script a document loads is whatever release the
 * CDN holds under that name: the document and its script come from different
 * builds without any rewriting, and the script's own hashed chunks stay
 * consistent with it.
 *
 * Plans are consumed one document request at a time and the last one repeats,
 * so "the CDN converges after the first request" is a two-entry list.
 */
export class Edge {
  readonly requests: DocumentRequest[] = [];
  private plans: Plan[] = [{ html: "a", assets: "a" }];
  private rewrite: Rewrite | undefined;
  private splice:
    { readonly path: string; readonly host: number; readonly from: Release } | undefined;
  private current: Plan = { html: "a", assets: "a" };
  private server: Server | undefined;
  baseUrl = "";

  private readonly options: EdgeOptions;

  constructor(options: EdgeOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const port = await findFreePort();

    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        response.statusCode = 502;
        response.end(`edge failure: ${String(error)}`);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** Starts a scenario: forgets earlier requests and sets the plans, the rewrite and the splice. */
  scenario(
    plans: readonly Plan[],
    extras: {
      readonly rewrite?: Rewrite;
      readonly splice?: { readonly path: string; readonly host: number; readonly from: Release };
    } = {},
  ): void {
    this.requests.length = 0;
    this.plans = [...plans];
    this.current = plans[0]!;
    this.rewrite = extras.rewrite;
    this.splice = extras.splice;
  }

  /** Changes what the NEXT document requests receive (a rollback, a CDN converging). */
  next(plans: readonly Plan[]): void {
    this.plans = [...plans];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "/";
    const path = url.split("?")[0]!;
    const isDocument = (request.headers.accept ?? "").includes("text/html") && !path.includes(".");

    if (isDocument) {
      const plan = this.plans.length > 1 ? this.plans.shift()! : this.plans[0]!;

      this.current = plan;
      this.requests.push({ path: url, plan });

      const upstream = await fetch(`${this.options.upstreams[plan.html]}${url}`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      let html = await upstream.text();

      if (this.splice && path === this.splice.path && upstream.status === 200) {
        html = await this.spliceHost(html, url);
      }
      if (this.rewrite && upstream.status === 200) html = this.rewrite(html);

      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "text/html",
        "cache-control": "no-store",
      });
      response.end(html);

      return;
    }

    const { html, assets } = this.current;
    const order: Release[] = assets === html ? [assets] : [assets, html];

    for (const release of order) {
      const upstream = await fetch(`${this.options.upstreams[release]}${url}`, {
        headers: { accept: request.headers.accept ?? "*/*" },
        redirect: "manual",
      });

      if (upstream.status === 404 && release !== order.at(-1)) continue;

      const headers: Record<string, string> = { "cache-control": "no-store" };
      const type = upstream.headers.get("content-type");

      if (type) headers["content-type"] = type;
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));

      return;
    }
  }

  /** Replaces the `host`-th `<product-details>` of `html` with the same host rendered by `splice.from`. */
  private async spliceHost(html: string, url: string): Promise<string> {
    const { host, from } = this.splice!;
    const foreign = await (
      await fetch(`${this.options.upstreams[from]}${url}`, { headers: { accept: "text/html" } })
    ).text();
    const own = hostRange(html, host);
    const other = hostRange(foreign, host);

    if (!own || !other) throw new Error("the document has no such Server Component host to splice");

    return html.slice(0, own[0]) + foreign.slice(other[0], other[1]) + html.slice(own[1]);
  }
}

/** The `[start, end)` range of the n-th `<product-details …>…</product-details>` element. */
function hostRange(html: string, index: number): [number, number] | undefined {
  let from = 0;

  for (let seen = 0; ; seen++) {
    const start = html.indexOf("<product-details", from);

    if (start < 0) return undefined;

    const close = "</product-details>";
    const end = html.indexOf(close, start);

    if (end < 0) return undefined;
    if (seen === index) return [start, end + close.length];
    from = end + close.length;
  }
}

/** The first module script a real document names: the browser entry of that release. */
export function entryScript(html: string): string | undefined {
  return (
    /<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1] ??
    /<script[^>]*\bsrc="([^"]+)"[^>]*\btype="module"/.exec(html)?.[1]
  );
}

export const exists = (path: string): boolean => existsSync(path) && readdirSync(path).length > 0;
