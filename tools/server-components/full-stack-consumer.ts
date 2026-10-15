import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { listFiles } from "../analog/lib/scan.ts";
import { run } from "../consumer/lib/exec.ts";
import type { CommandResult } from "../consumer/lib/exec.ts";
import {
  EXCLUDED_PACKAGES,
  REGISTRY_PACKAGES,
  assertPublishSelection,
  inspectTarball,
  packPackage,
  readManifest,
} from "../release/lib/packages.ts";
import type { PublishablePackage } from "../release/lib/packages.ts";

import {
  CONTROLLER_FINGERPRINT,
  EXPECTED_EVIDENCE,
  FULL_STACK_MARKERS,
  FULL_STACK_SERVER_SOURCES,
  PRIVATE_CANARIES,
  PRODUCT_42,
  SERVER_ONLY_MARKERS,
} from "./lib/full-stack-fixture.ts";
import { check, finish, repoRoot, section } from "./lib/harness.ts";
import { moduleGraph } from "./lib/module-graph.ts";
import {
  evaluate,
  findInstalledCopies,
  installedVersion,
  isSymlinkAnywhere,
  isUnder,
  isolatedEnv,
  openTracked,
  readTarball,
  resolveFromConsumer,
  restoreDir,
  snapshotDiffers,
  snapshotDir,
  startNodeServer,
  startWrangler,
  until,
} from "./lib/package-consumer.ts";
import type { RunningServer, Snapshot, Tracked } from "./lib/package-consumer.ts";
import { COMPATIBILITY_DATE } from "./lib/wrangler.ts";

/**
 * `pnpm test:full-stack-package-consumer`: do the PACKED @strata-sc/core,
 * @strata-sc/analog and @strata-sc/server-components work together in ONE
 * independent Analog application outside the Strata workspace?
 * (docs/research/full-stack-external-consumer.md)
 *
 *   package builds → `pnpm pack` → three .tgz (the only connection)
 *   → OS temp directory → `npm install` → real Analog app with
 *       Strata controller → HTTP API → interactive Angular island
 *       server-only repository → @ServerComponent() → SSR HTML → hydrated island
 *   → tarball/install/dependency-graph integrity, declarations (TS 6 and 5.9),
 *     Node production build + SSR + hydration + navigation, server-only
 *     firewall, Cloudflare Pages build + local workerd.
 *
 * It never edits a package manifest, never publishes, and never resolves
 * anything from the repository: the consumer's own `node_modules` run every
 * command.
 */

const TITLE = "full-stack packed-package consumer qualification";
const fixtureTemplate = join(repoRoot, "tests", "full-stack-package-consumer", "fixture");
const TS59_VERSION = "5.9.2";
const PACKAGES: readonly PublishablePackage[] = REGISTRY_PACKAGES;
const [CORE, ANALOG, SERVER_COMPONENTS] = PACKAGES as [
  PublishablePackage,
  PublishablePackage,
  PublishablePackage,
];

const sanitize = (text: string): string => stripVTControlCharacters(text);
const all = (results: readonly boolean[]): boolean => results.every(Boolean);

const verdict = {
  install: false,
  controllerIntegration: false,
  serverComponents: false,
  island: false,
  declarations59: false,
  declarations6: false,
  node: false,
  firewall: false,
  cloudflare: false,
  confidentiality: false,
};

const timings: string[] = [];
const timeAsync = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const started = performance.now();

  try {
    return await work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};
const time = <T>(label: string, work: () => T): T => {
  const started = performance.now();

  try {
    return work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};

class Abort extends Error {}

function must(result: CommandResult, label: string): CommandResult {
  const ok = check(
    `${label} exits 0`,
    result.status === 0,
    sanitize(result.stderr || result.stdout).slice(-2_500),
  );

  if (!ok) throw new Abort(label);

  return result;
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const sha512Integrity = (path: string): string =>
  `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;

const servers: RunningServer[] = [];
const tmpRoot = mkdtempSync(join(tmpdir(), "strata-full-stack-consumer-"));
const consumerDir = join(tmpRoot, "consumer");
const ts59Dir = join(tmpRoot, "consumer-ts59");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);

/** Everything under the consumer that is output or install, not authored source. */
const NOT_SOURCE = (path: string): boolean =>
  /^(node_modules|dist|\.nitro|\.output|\.angular|package-lock\.json)(\/|$)/.test(path) ||
  path.startsWith("src/generated/");

let templateBefore: Snapshot | undefined;
let pristine: Snapshot | undefined;

/** The consumer's own `vite` binary (never the repository's). */
const vite = (args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): CommandResult =>
  run(process.execPath, [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), ...args], {
    cwd: consumerDir,
    env: { ...env, ...extraEnv },
  });

function clean(): void {
  for (const dir of ["dist", "src/generated", ".nitro", ".angular"]) {
    rmSync(join(consumerDir, dir), { recursive: true, force: true });
  }
}

function build(label: string, extraEnv: NodeJS.ProcessEnv = {}): CommandResult {
  clean();

  return time(label, () => must(vite(["build"], extraEnv), label));
}

const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);
const graphFiles = (dirs: readonly string[], skip: (file: string) => boolean = () => false) =>
  dirs
    .flatMap((dir) =>
      existsSync(dist(dir)) ? listFiles(dist(dir)).map((file) => `${dir}/${file}`) : [],
    )
    .filter((file) => !skip(file));
const filesWith = (files: readonly string[], needle: string): string[] =>
  files.filter((file) => readFileSync(dist(file), "utf8").includes(needle));

/** Source paths named by the `.map` files among `files`. */
function mapSources(files: readonly string[]): string[] {
  return files
    .filter((file) => file.endsWith(".map"))
    .flatMap(
      (file) =>
        (JSON.parse(readFileSync(dist(file), "utf8")) as { sources?: string[] }).sources ?? [],
    );
}

const hasCanary = (text: string): string[] => PRIVATE_CANARIES.filter((c) => text.includes(c));

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

async function get(url: string): Promise<Reply> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  return { status: response.status, headers: response.headers, body: await response.text() };
}

const json = <T>(reply: Reply): T => JSON.parse(reply.body) as T;

/**
 * HTTP qualification of a running build (Node or workerd): controller API,
 * native Nitro route, request-scoped lifecycle and the Server Component page.
 */
async function httpSuite(base: string, label: string, log: () => string): Promise<boolean[]> {
  const ok: boolean[] = [];

  const product = await get(`${base}/api/products/42`);

  ok.push(
    check(
      `${label}: GET /api/products/42 → 200 JSON from the Strata controller`,
      product.status === 200 &&
        !!product.headers.get("content-type")?.includes("application/json") &&
        JSON.stringify(json(product)) === JSON.stringify(PRODUCT_42),
      `${product.status} ${product.body}`,
    ),
    check(
      `${label}: the controller really ran (catalog fingerprint header, no-store)`,
      product.headers.get("x-fullstack-catalog") === CONTROLLER_FINGERPRINT &&
        product.headers.get("cache-control") === "no-store",
      String(product.headers.get("x-fullstack-catalog")),
    ),
    check(
      `${label}: the public API JSON and headers carry no private canary`,
      hasCanary(`${product.body}${[...product.headers].join(";")}`).length === 0,
    ),
  );

  const seven = await get(`${base}/api/products/7`);

  ok.push(
    check(
      `${label}: path parameter selects the resource (/api/products/7 → unavailable)`,
      seven.status === 200 && json<{ id: string; available: boolean }>(seven).available === false,
      seven.body,
    ),
  );

  const unknown = await get(`${base}/api/products/999`);

  ok.push(
    check(
      `${label}: unknown resource → controller-returned 404 JSON, no-store`,
      unknown.status === 404 &&
        unknown.body === '{"error":"not_found"}' &&
        unknown.headers.get("cache-control") === "no-store",
      `${unknown.status} ${unknown.body}`,
    ),
  );

  const repeated = await Promise.all([1, 2, 3].map(() => get(`${base}/api/products/42`)));

  ok.push(
    check(
      `${label}: repeated requests return the same public answer`,
      repeated.every((reply) => reply.status === 200 && reply.body === product.body),
    ),
  );

  // Request-scoped lifecycle: a new controller instance and a cleanup per request.
  const stats = async (): Promise<{ created: number; cleaned: number }> =>
    json(await get(`${base}/api/lifecycle-stats`));
  const before = await stats();
  const sequential: { instance: number; calls: number }[] = [];

  for (let index = 0; index < 3; index++) {
    sequential.push(json(await get(`${base}/api/products/42/lifecycle`)));
  }

  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => get(`${base}/api/products/42/lifecycle`)),
  );
  const instances = [
    ...sequential,
    ...concurrent.map((reply) => json<(typeof sequential)[0]>(reply)),
  ];
  const after = await stats();

  ok.push(
    check(
      `${label}: every request has its own controller instance (calls === 1, 11 distinct instances)`,
      instances.every((i) => i.calls === 1) &&
        new Set(instances.map((i) => i.instance)).size === instances.length &&
        sequential[0]!.instance < sequential[1]!.instance &&
        sequential[1]!.instance < sequential[2]!.instance,
      JSON.stringify(instances),
    ),
    check(
      `${label}: the factory created and cleaned up exactly one controller per request (+11/+11)`,
      after.created - before.created === 11 && after.cleaned - before.cleaned === 11,
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    ),
  );

  const native = await get(`${base}/api/native`);

  ok.push(
    check(
      `${label}: the native Nitro route still works next to the controller`,
      native.status === 200 && native.body === '{"source":"analog"}',
      native.body,
    ),
  );

  // Server Component page.
  const page = await get(`${base}/products/42`);
  const html = page.body;

  ok.push(
    check(
      `${label}: GET /products/42 → 200 text/html`,
      page.status === 200 && !!page.headers.get("content-type")?.includes("text/html"),
    ),
    check(
      `${label}: the Server Component rendered on the server (title and computed tier)`,
      html.includes("<h1>Product 42</h1>") &&
        html.includes('<p id="server-tier">Tier: premium</p>'),
    ),
    check(
      `${label}: the server-only repository ran (data-evidence hashes every server-only value)`,
      html.includes(`data-evidence="${EXPECTED_EVIDENCE}"`),
      html.match(/data-evidence="[^"]*"/)?.[0] ?? "no evidence",
    ),
    check(
      `${label}: client boundary is protocol v1, ngh-annotated, props are exactly {"productId":"42"}`,
      /<product-availability data-strata-client="product-availability" data-strata-protocol="1" data-strata-props="\{&quot;productId&quot;:&quot;42&quot;\}" ngh="\d+">/.test(
        html,
      ),
      html.match(/<product-availability[^>]*>/)?.[0] ?? "no boundary",
    ),
    check(
      `${label}: the SSR document (HTML, hydration metadata, props) carries no private canary`,
      hasCanary(html).length === 0,
      hasCanary(html).join(", "),
    ),
    check(
      `${label}: SSR shows the island's initial public state`,
      html.includes("Availability: not checked") && html.includes("Refresh availability"),
    ),
  );

  const missing = await get(`${base}/products/999`);

  ok.push(
    check(
      `${label}: an unknown product renders the not-found branch, no island, no canary (status stays 200: documented soft-404)`,
      missing.status === 200 &&
        missing.body.includes('id="not-found"') &&
        !missing.body.includes("<product-availability") &&
        hasCanary(missing.body).length === 0,
    ),
  );
  ok.push(
    check(
      `${label}: the server log shows no JIT fallback or error`,
      !/JIT compilation|needs to be compiled using the JIT|ERROR|Code generation from strings/.test(
        sanitize(log()),
      ),
      sanitize(log()).slice(-600),
    ),
  );

  return ok;
}

interface BrowserResult {
  readonly ok: boolean[];
}

const HYDRATED = "product-availability[data-strata-hydrated]";

/** Browser qualification: SSR DOM reuse, one click = one API request = one state update. */
async function islandSuite(base: string, label: string): Promise<BrowserResult> {
  const ok: boolean[] = [];
  const tracked = await openTracked();
  const { page } = tracked;
  const bodies: { url: string; type: string; body: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  page.on("response", (response) => {
    const type = response.request().resourceType();

    if (!["document", "script", "fetch", "xhr"].includes(type)) return;
    void response.text().then(
      (body) => bodies.push({ url: response.url(), type, body }),
      () => undefined,
    );
  });
  // Hold the application scripts so the SSR DOM can be tagged before hydration.
  await page.route("**/*.js", async (route) => {
    await gate;
    await route.continue();
  });

  try {
    // Module scripts are deferred, so DOMContentLoaded would wait for the held scripts.
    await page.goto(`${base}/products/42`, { waitUntil: "commit" });
    await page.waitForSelector("product-availability button", { state: "attached" });

    const before = await evaluate<{
      title: string | null;
      status: string | null;
      hydrated: boolean;
    }>(
      page,
      `(() => {
        const button = document.querySelector('product-availability button');
        const output = document.querySelector('product-availability output');
        window.__ssr = { button, output, outputText: output && output.firstChild, heading: document.querySelector('h1') };
        return {
          title: document.querySelector('h1')?.textContent ?? null,
          status: output?.textContent ?? null,
          hydrated: !!document.querySelector('product-availability[data-strata-hydrated]'),
        };
      })()`,
    );

    release();
    await page.waitForSelector(HYDRATED, { timeout: 15_000 });

    const same = await evaluate<Record<string, boolean>>(
      page,
      `(() => ({
        button: window.__ssr.button === document.querySelector('product-availability button'),
        output: window.__ssr.output === document.querySelector('product-availability output'),
        text: window.__ssr.outputText === document.querySelector('product-availability output').firstChild,
        heading: window.__ssr.heading === document.querySelector('h1'),
      }))()`,
    );
    const hydration = await evaluate<{ ngh: number; islands: number }>(
      page,
      `({ ngh: document.querySelectorAll('[ngh]').length, islands: document.querySelectorAll('[data-strata-hydrated]').length })`,
    );

    ok.push(
      check(
        `${label}: before any script the server HTML is visible with the initial state`,
        before.title === "Product 42" &&
          before.status === "Availability: not checked" &&
          !before.hydrated,
        JSON.stringify(before),
      ),
      check(
        `${label}: the island hydrates reusing the SSR nodes (heading, button, output, text node)`,
        Object.values(same).every(Boolean),
        JSON.stringify(same),
      ),
      check(
        `${label}: no leftover ngh annotation and exactly one island`,
        hydration.ngh === 0 && hydration.islands === 1,
        JSON.stringify(hydration),
      ),
    );

    // One click → exactly one API request → one state update.
    await evaluate(
      page,
      `(() => {
        window.__states = [];
        const output = document.querySelector('product-availability output');
        new MutationObserver(() => window.__states.push(output.textContent)).observe(output, { childList: true, characterData: true, subtree: true });
      })()`,
    );

    const apiRequests = (): string[] =>
      tracked.requests.filter((r) => r.url.endsWith("/api/products/42")).map((r) => r.type);
    const apiBefore = apiRequests().length;
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/products/42")),
      page.click("product-availability button"),
    ]);

    await page.waitForFunction(
      "document.querySelector('product-availability output')?.textContent === 'Availability: available'",
      undefined,
      { timeout: 10_000 },
    );
    // A short quiet period only proves nothing else follows; the facts above are event-driven.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const states = await evaluate<string[]>(page, "window.__states");
    const finalPublic = (await response.json()) as typeof PRODUCT_42;

    ok.push(
      check(
        `${label}: one click sent exactly one fetch to the Strata controller and got the public JSON`,
        apiRequests().length - apiBefore === 1 &&
          response.status() === 200 &&
          JSON.stringify(finalPublic) === JSON.stringify(PRODUCT_42) &&
          response.headers()["x-fullstack-catalog"] === CONTROLLER_FINGERPRINT,
        `${apiRequests().join(",")} ${response.status()}`,
      ),
      check(
        `${label}: the response updated the Angular state exactly once ("Availability: available")`,
        states.length === 1 && states[0] === "Availability: available",
        JSON.stringify(states),
      ),
      check(
        `${label}: the SSR button and output survived the interaction`,
        await evaluate<boolean>(
          page,
          "window.__ssr.button === document.querySelector('product-availability button') && window.__ssr.output === document.querySelector('product-availability output')",
        ),
      ),
    );

    // Confidentiality of everything the browser received or rendered.
    const outer = await evaluate<string>(page, "document.documentElement.outerHTML");
    const received = bodies.map((entry) => `${entry.url}\n${entry.body}`).join("\n");

    ok.push(
      check(
        `${label}: no private canary in the hydrated DOM`,
        hasCanary(outer).length === 0,
        hasCanary(outer).join(", "),
      ),
      check(
        `${label}: no private canary in any document, script or API response the browser received`,
        hasCanary(received).length === 0 && bodies.length > 3,
        `${bodies.length} bodies; ${hasCanary(received).join(", ")}`,
      ),
      check(
        `${label}: the client marker was loaded; the browser received no controller/adapter code`,
        bodies.some((e) => e.type === "script" && e.body.includes(FULL_STACK_MARKERS.client)) &&
          bodies
            .filter((e) => e.type === "script")
            .every(
              (e) =>
                !e.body.includes("registerControllers") &&
                !e.body.includes("getControllerDefinition") &&
                !e.body.includes("ProductsController"),
            ),
      ),
      check(
        `${label}: no console error/warning (no NG hydration, JIT or unlinked-partial message)`,
        tracked.errors.length === 0,
        tracked.errors.join(" | "),
      ),
    );
  } finally {
    release();
    await tracked.close();
  }

  return { ok };
}

/** Document navigation into and out of the Server Component route. */
async function navigationSuite(base: string, label: string): Promise<boolean[]> {
  const ok: boolean[] = [];
  const tracked: Tracked = await openTracked();
  const { page } = tracked;
  const hydrated = (): Promise<boolean> =>
    page.waitForSelector(HYDRATED, { timeout: 15_000 }).then(
      () => true,
      () => false,
    );
  const status = (): Promise<string | null> =>
    page.locator("product-availability output").textContent();
  const documentRequests = (fragment: string): number =>
    tracked.requests.filter((r) => r.navigation && r.url.includes(fragment)).length;
  const apiCount = (): number =>
    tracked.requests.filter((r) => r.url.endsWith("/api/products/42")).length;
  const refresh = async (): Promise<string | null> => {
    const mark = apiCount();

    await page.click("product-availability button");
    await page
      .waitForFunction(
        "document.querySelector('product-availability output')?.textContent === 'Availability: available'",
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => undefined);

    return apiCount() - mark === 1 ? await status() : `requests: ${apiCount() - mark}`;
  };

  try {
    // Plain-anchor document navigation.
    await page.goto(`${base}/`, { waitUntil: "load" });
    await evaluate(page, "window.__NAV_SENTINEL__ = 'home'");
    const documentsBefore = documentRequests("/products/42");

    await page.click("#to-product");
    await page.waitForURL("**/products/42");

    const direct = await hydrated();
    const sentinelAfterLink = await evaluate<string | undefined>(page, "window.__NAV_SENTINEL__");

    ok.push(
      check(
        `${label}: document link / → /products/42 is a real document request and the island hydrates`,
        direct &&
          sentinelAfterLink === undefined &&
          documentRequests("/products/42") - documentsBefore === 1,
      ),
      check(
        `${label}: the island works after the document navigation (one click, one request)`,
        (await refresh()) === "Availability: available",
      ),
    );

    // Away, Back, re-entry.
    await page.click("#to-about");
    await page.waitForURL("**/about");
    await page.goBack();
    await page.waitForURL("**/products/42");

    const reentered = await hydrated();
    const fresh = await status();

    ok.push(
      check(
        `${label}: Back re-enters the Server Component page, hydrated, from a fresh state`,
        reentered && fresh === "Availability: not checked",
        `${reentered} ${fresh}`,
      ),
      check(
        `${label}: after re-entry one click is one request and exactly one island exists`,
        (await refresh()) === "Availability: available" &&
          (await evaluate<number>(
            page,
            "document.querySelectorAll('[data-strata-hydrated]').length",
          )) === 1,
      ),
    );

    await page.goForward();
    await page.waitForURL("**/about");
    ok.push(
      check(
        `${label}: Forward reaches /about`,
        (await page.locator("main h1").textContent()) === "About",
      ),
    );

    // The opt-in package guard: an Angular Router link becomes a document request.
    await page.goto(`${base}/`, { waitUntil: "load" });
    await evaluate(page, "window.__NAV_SENTINEL__ = 'router'");
    const guardBefore = documentRequests("/products/42?ref=home");

    await page.click("#router-link");
    await page.waitForURL("**/products/42?ref=home#details");

    const guarded = await hydrated();
    const sentinelAfterGuard = await evaluate<string | undefined>(page, "window.__NAV_SENTINEL__");

    ok.push(
      check(
        `${label}: strataDocumentNavigationGuard turns a Router link into one real document request, preserving query and fragment`,
        guarded &&
          sentinelAfterGuard === undefined &&
          documentRequests("/products/42?ref=home") - guardBefore === 1 &&
          page.url().endsWith("/products/42?ref=home#details"),
        `${page.url()} ${documentRequests("/products/42?ref=home") - guardBefore}`,
      ),
      check(
        `${label}: the island works after the guarded navigation`,
        (await refresh()) === "Availability: available",
      ),
    );

    await page.goBack();
    await page.waitForURL(`${base}/`);
    await page.goForward();
    ok.push(
      check(
        `${label}: Back to / and Forward return to the hydrated product page`,
        (await hydrated()) &&
          (await evaluate<number>(
            page,
            "document.querySelectorAll('[data-strata-hydrated]').length",
          )) === 1,
      ),
      check(
        `${label}: no console error/warning during navigation`,
        tracked.errors.length === 0,
        tracked.errors.join(" | "),
      ),
    );
  } finally {
    await tracked.close();
  }

  return ok;
}

try {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");
  templateBefore = snapshotDir(fixtureTemplate, () => false);

  // ------------------------------------------------------------------------
  section("Release invariants: three registry-eligible packages, versions owned by Changesets");

  assertPublishSelection(PACKAGES);

  const manifests = PACKAGES.map((pkg) => ({
    pkg,
    manifest: readManifest(join(repoRoot, pkg.dir)),
  }));

  for (const { pkg, manifest } of manifests) {
    console.log(`manifest: ${manifest.name}@${manifest.version}`);
    check(
      `${pkg.name}@${manifest.version} is public and registry-eligible`,
      manifest.name === pkg.name && manifest.private === undefined,
    );
  }
  check(
    "@strata-sc/h3 stays excluded and is not part of this consumer",
    EXCLUDED_PACKAGES.includes("@strata-sc/h3") &&
      !PACKAGES.some((p) => p.name === "@strata-sc/h3"),
  );

  // ------------------------------------------------------------------------
  section("Build and pack the three real packages");

  for (const pkg of PACKAGES)
    rmSync(join(repoRoot, pkg.dir, "dist"), { recursive: true, force: true });
  time("package builds", () =>
    must(
      run("pnpm", [...PACKAGES.flatMap(({ name }) => ["--filter", name]), "run", "build"], {
        cwd: repoRoot,
      }),
      "pnpm build (core, analog, server-components)",
    ),
  );

  const tarballDir = join(tmpRoot, "tarballs");

  mkdirSync(tarballDir, { recursive: true });

  const tarballs = new Map<string, { path: string; sha256: string; integrity: string }>();
  const tarballOk: boolean[] = [];

  for (const pkg of PACKAGES) {
    const path = packPackage(repoRoot, pkg, tarballDir);
    const inspection = inspectTarball(repoRoot, path);
    const extracted = readTarball(
      path,
      join(tmpRoot, "extracted", pkg.dir.replace("packages/", "")),
    );
    const entry = { path, sha256: sha256(path), integrity: sha512Integrity(path) };

    tarballs.set(pkg.name, entry);
    console.log(
      `tarball: ${path.split("/").pop()}  ${inspection.sizeBytes} bytes  sha256 ${entry.sha256}\n  ${entry.integrity}`,
    );
    tarballOk.push(
      check(
        `${pkg.name} tarball is externally installable (release inspector: 0 problems)`,
        inspection.problems.length === 0,
        inspection.problems.join("; "),
      ),
      check(
        `${pkg.name} tarball: no workspace:/link:/portal:/file: range in any dependency field`,
        !/"(workspace|link|portal|file):/.test(
          JSON.stringify([
            extracted.manifest.dependencies,
            extracted.manifest.peerDependencies,
            extracted.manifest.optionalDependencies,
          ]),
        ),
      ),
    );
  }

  const packedAnalog = readTarball(
    tarballs.get(ANALOG.name)!.path,
    join(tmpRoot, "extracted-analog"),
  ).manifest;
  const coreVersion = manifests[0]!.manifest.version;

  tarballOk.push(
    check(
      "the packed @strata-sc/analog depends on @strata-sc/core by a concrete version equal to the packed core",
      packedAnalog.dependencies?.[CORE.name] === coreVersion,
      JSON.stringify(packedAnalog.dependencies),
    ),
  );

  // ------------------------------------------------------------------------
  section("External install (npm, outside the workspace, the three tarballs only)");

  check(
    "the consumer lives outside the repository",
    !consumerDir.startsWith(repoRoot) && !realpathSync(tmpRoot).startsWith(realpathSync(repoRoot)),
  );
  cpSync(fixtureTemplate, consumerDir, { recursive: true });

  const consumerManifestPath = join(consumerDir, "package.json");
  const consumerManifest = JSON.parse(readFileSync(consumerManifestPath, "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  check(
    "the fixture template names no workspace, link or relative dependency",
    !/workspace:|link:|portal:|\.\.\//.test(JSON.stringify(consumerManifest)),
  );
  check(
    "the fixture is not part of pnpm-workspace.yaml",
    !/tests\//.test(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")),
  );
  check(
    "the fixture template declares all three Strata packages (the runner supplies the tarballs)",
    PACKAGES.every(({ name }) => consumerManifest.dependencies[name] === "REPLACED_BY_RUNNER"),
  );

  for (const pkg of PACKAGES) {
    consumerManifest.dependencies[pkg.name] = `file:${tarballs.get(pkg.name)!.path}`;
  }
  writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);
  pristine = snapshotDir(consumerDir, NOT_SOURCE);

  const installArgs = ["install", "--no-audit", "--no-fund", "--loglevel=error"];

  console.log(
    `install command: npm ${installArgs.join(" ")}  (cwd ${consumerDir}; empty user config; npm_*/pnpm_*/NODE_PATH/NODE_OPTIONS removed)`,
  );
  time("npm install (consumer)", () =>
    must(run("npm", installArgs, { cwd: consumerDir, env }), "npm install"),
  );

  const installOk: boolean[] = [];
  const lock = JSON.parse(readFileSync(join(consumerDir, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };

  for (const pkg of PACKAGES) {
    const installed = join(consumerDir, "node_modules", pkg.name);
    const tarball = tarballs.get(pkg.name)!;
    const extractedDir = join(
      tmpRoot,
      pkg === ANALOG ? "extracted-analog" : join("extracted", pkg.dir.replace("packages/", "")),
    );
    const version = readManifest(join(repoRoot, pkg.dir)).version;
    const packedFiles = listFiles(extractedDir);
    const installedFiles = listFiles(installed).filter((f) => !f.startsWith("node_modules/"));
    const differing = packedFiles.filter(
      (file) =>
        !existsSync(join(installed, file)) ||
        sha256(join(installed, file)) !== sha256(join(extractedDir, file)),
    );
    const entry = lock.packages[`node_modules/${pkg.name}`];

    installOk.push(
      check(
        `${pkg.name}: a real directory (no symlink, junction or portal) at version ${version}`,
        existsSync(join(installed, "package.json")) &&
          !isSymlinkAnywhere(installed) &&
          lstatSync(installed).isDirectory() &&
          installedVersion(consumerDir, pkg.name) === version,
      ),
      check(
        `${pkg.name}: installed files are byte-identical to the tarball's (${packedFiles.length} files, no src/)`,
        differing.length === 0 &&
          installedFiles.join("\n") === packedFiles.join("\n") &&
          !existsSync(join(installed, "src")),
        differing.join(", "),
      ),
      check(
        `${pkg.name}: package-lock resolves it from the local tarball with the tarball's sha512 (never a registry)`,
        entry?.resolved?.startsWith("file:") === true &&
          !/^https?:/.test(entry.resolved) &&
          entry.integrity === tarball.integrity,
        JSON.stringify(entry),
      ),
      check(
        `${pkg.name}: exactly one installed copy`,
        findInstalledCopies(consumerDir, pkg.name).length === 1,
        findInstalledCopies(consumerDir, pkg.name).join(", "),
      ),
    );
  }

  const strataInstalled = readdirSync(join(consumerDir, "node_modules", "@strata-sc")).sort();

  installOk.push(
    check(
      "exactly @strata-sc/{analog,core,server-components} are installed (no @strata-sc/h3)",
      strataInstalled.join(",") === "analog,core,server-components",
      strataInstalled.join(","),
    ),
    check(
      "no lock entry resolves any @strata-sc package from a registry URL",
      Object.entries(lock.packages)
        .filter(([key]) => key.includes("@strata-sc/"))
        .every(([, value]) => value.resolved?.startsWith("file:") === true),
    ),
  );

  const installedAnalog = JSON.parse(
    readFileSync(join(consumerDir, "node_modules", ANALOG.name, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  installOk.push(
    check(
      "the installed @strata-sc/analog's @strata-sc/core dependency is the concrete packed version",
      installedAnalog.dependencies?.[CORE.name] === coreVersion,
      JSON.stringify(installedAnalog.dependencies),
    ),
  );

  const specifiers = [
    CORE.name,
    ANALOG.name,
    SERVER_COMPONENTS.name,
    `${SERVER_COMPONENTS.name}/vite`,
    `${SERVER_COMPONENTS.name}/navigation`,
    `${SERVER_COMPONENTS.name}/server-only`,
  ];
  const resolved = resolveFromConsumer(consumerDir, specifiers, env);

  for (const [specifier, url] of Object.entries(resolved))
    console.log(`resolve ${specifier} → ${url}`);

  installOk.push(
    check(
      "all six public entry points resolve to the packed dist/ files under consumer/node_modules",
      specifiers.every((s) => {
        const url = resolved[s]!;
        const name = s.startsWith(SERVER_COMPONENTS.name) ? SERVER_COMPONENTS.name : s;

        return (
          isUnder(url, join(consumerDir, "node_modules")) &&
          url.includes(`/node_modules/${name}/dist/`)
        );
      }),
    ),
    check(
      "nothing resolves into the Strata repository",
      Object.values(resolved).every(
        (url) => !realpathSync(new URL(url)).startsWith(realpathSync(repoRoot) + "/"),
      ),
    ),
  );

  const fromAnalog = resolveFromConsumer(
    join(consumerDir, "node_modules", ANALOG.name),
    [CORE.name],
    env,
  );

  installOk.push(
    check(
      "@strata-sc/analog resolves @strata-sc/core to the single packed core (not a registry copy)",
      fromAnalog[CORE.name] === resolved[CORE.name],
      `${fromAnalog[CORE.name]} vs ${resolved[CORE.name]}`,
    ),
  );

  const copiesOf = (name: string): string[] => findInstalledCopies(consumerDir, name);

  installOk.push(
    check(
      "one installed copy each of @angular/core, @angular/compiler and typescript",
      copiesOf("@angular/core").length === 1 &&
        copiesOf("@angular/compiler").length === 1 &&
        copiesOf("typescript").length === 1,
      [copiesOf("@angular/core"), copiesOf("@angular/compiler"), copiesOf("typescript")]
        .map((c) => c.join(","))
        .join(" | "),
    ),
  );

  const ls = run("npm", ["ls", "--all", "--json"], { cwd: consumerDir, env });
  const problems = (JSON.parse(ls.stdout || "{}") as { problems?: string[] }).problems ?? [];
  const problemName = (p: string): string => p.replace(/\s\/\S+$/, "");

  console.log(`npm ls --all: exit ${ls.status}; ${problems.length} problem(s)`);
  installOk.push(
    check(
      "npm ls --all reports no UNMET, invalid or extraneous Strata, Angular, Analog, Vite, TypeScript or Nitro package",
      problems.every(
        (p) =>
          !/UNMET|@strata-sc\/|@angular\/|@analogjs\/|\/vite|typescript|nitro|wrangler|rxjs|tslib/i.test(
            problemName(p),
          ),
      ),
      problems.join("; "),
    ),
  );

  const line = (names: readonly string[]): string =>
    names.map((name) => `${name}@${installedVersion(consumerDir, name)}`).join(", ");

  console.log(`node ${process.version}`);
  console.log(
    `tuple: ${line(["@angular/core", "@angular/common", "@angular/compiler", "@angular/router", "@angular/platform-browser", "@angular/platform-server", "@angular/compiler-cli", "@angular/build"])}`,
  );
  console.log(
    `       ${line(["@analogjs/platform", "@analogjs/router", "@analogjs/vite-plugin-angular", "@analogjs/vite-plugin-nitro", "nitropack", "h3", "vite", "typescript", "rxjs", "tslib", "wrangler"])}`,
  );

  verdict.install = all([...tarballOk, ...installOk]);

  // ------------------------------------------------------------------------
  section("Declaration portability (TypeScript 6 and 5.9, skipLibCheck: false)");

  const tscDeclarations = (dir: string, label: string): { ok: boolean; version: string } => {
    const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
    const version = installedVersion(dir, "typescript");
    const configs = ["tsconfig.check.json", "tsconfig.check.server.json"];
    const results = configs.map((config) =>
      run(process.execPath, [tsc, "-p", config, "--listFiles", "--noEmit"], { cwd: dir, env }),
    );
    const lines = results.flatMap((r) =>
      r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const listed = lines.filter((l) => l.startsWith("/"));
    const diagnostics = lines.filter((l) => /error TS\d+/.test(l));
    const strata = listed.filter((file) => file.includes("/@strata-sc/"));
    const fromRepo = listed.filter((file) =>
      realpathSync(file).startsWith(realpathSync(repoRoot) + "/"),
    );
    const entries: [string, string][] = [
      [CORE.name, "dist/index.d.ts"],
      [ANALOG.name, "dist/index.d.ts"],
      [SERVER_COMPONENTS.name, "dist/fesm2022/index.d.ts"],
      [SERVER_COMPONENTS.name, "dist/vite/index.d.ts"],
      [SERVER_COMPONENTS.name, "dist/server-only/index.d.ts"],
      [SERVER_COMPONENTS.name, "dist/fesm2022/navigation/index.d.ts"],
    ];

    console.log(
      `${label}: typescript@${version}, ${listed.length} files, ${strata.length} from the installed Strata packages, ${diagnostics.length} diagnostic(s)`,
    );

    return {
      version,
      ok: all([
        check(
          `${label}: both consumer projects (Angular decorators, standard-decorator controllers) — strict, skipLibCheck:false, Bundler — 0 diagnostics`,
          results.every((r) => r.status === 0) && diagnostics.length === 0,
          diagnostics.slice(0, 8).join("\n") || results.map((r) => r.stderr).join("\n"),
        ),
        check(
          `${label}: every public entry's declaration (core, analog, server-components, /vite, /navigation, /server-only) is read from node_modules`,
          entries.every(([name, file]) =>
            strata.some((s) => s.endsWith(`/node_modules/${name}/${file}`)),
          ) && strata.every((file) => file.includes("/node_modules/@strata-sc/")),
          entries
            .filter(
              ([name, file]) => !strata.some((s) => s.endsWith(`/node_modules/${name}/${file}`)),
            )
            .map(([name, file]) => `${name}/${file}`)
            .join(", "),
        ),
        check(
          `${label}: no file resolves from the repository or from package src/`,
          fromRepo.length === 0 && !listed.some((file) => /@strata-sc\/[^/]+\/src\//.test(file)),
          fromRepo.join(", "),
        ),
      ]),
    };
  };

  const ts6 = tscDeclarations(consumerDir, "TypeScript 6");

  check("TypeScript 6.0.3 is the declaration consumer", ts6.version === "6.0.3", ts6.version);
  verdict.declarations6 = ts6.ok && ts6.version === "6.0.3";

  mkdirSync(join(ts59Dir, "src", "check"), { recursive: true });
  for (const file of [
    "tsconfig.check.json",
    "tsconfig.check.server.json",
    "src/check/declarations.ts",
    "src/check/controller-declarations.ts",
  ]) {
    cpSync(join(consumerDir, file), join(ts59Dir, file));
  }
  writeFileSync(
    join(ts59Dir, "package.json"),
    `${JSON.stringify(
      {
        name: "strata-full-stack-declarations-ts59",
        private: true,
        type: "module",
        dependencies: {
          ...Object.fromEntries(
            PACKAGES.map((p) => [p.name, `file:${tarballs.get(p.name)!.path}`]),
          ),
          ...Object.fromEntries(
            [
              "@angular/core",
              "@angular/common",
              "@angular/compiler",
              "@angular/router",
              "rxjs",
            ].map((name) => [name, consumerManifest.dependencies[name]]),
          ),
          vite: consumerManifest.devDependencies["vite"],
          "@types/node": consumerManifest.devDependencies["@types/node"],
          typescript: TS59_VERSION,
        },
      },
      null,
      2,
    )}\n`,
  );
  time("npm install (TypeScript 5.9 consumer)", () =>
    must(run("npm", installArgs, { cwd: ts59Dir, env }), "npm install (TypeScript 5.9 consumer)"),
  );

  const ts59 = tscDeclarations(ts59Dir, "TypeScript 5.9");

  check(
    `TypeScript ${TS59_VERSION} is the declaration consumer`,
    ts59.version === TS59_VERSION,
    ts59.version,
  );
  verdict.declarations59 = ts59.ok && ts59.version === TS59_VERSION;

  // ------------------------------------------------------------------------
  section("External production build (Node): graph separation");

  build("consumer `vite build`");

  const surrogate = join(
    consumerDir,
    "src",
    "generated",
    "server-components",
    "products",
    "product-details.server-component.ts",
  );

  check(
    "the Server Component surrogate is generated inside the EXTERNAL app",
    existsSync(surrogate),
  );
  check(
    "the surrogate imports the runtime as `@strata-sc/server-components`, never a path",
    /from "@strata-sc\/server-components";/.test(readFileSync(surrogate, "utf8")) &&
      !readFileSync(surrogate, "utf8").includes(repoRoot),
  );

  const browserDirs = ["client", "analog/public"] as const;
  const browser = graphFiles(browserDirs);
  const server = graphFiles(["analog/server", "ssr"]);
  const browserJs = browser.filter((f) => f.endsWith(".js"));
  const serverJs = server.filter((f) => /\.(m?js)$/.test(f));
  const graphOk: boolean[] = [];

  for (const marker of PRIVATE_CANARIES) {
    graphOk.push(
      check(
        `${marker}: absent from every browser file, source map included`,
        filesWith(browser, marker).length === 0,
        filesWith(browser, marker).join(", "),
      ),
    );
  }
  for (const marker of SERVER_ONLY_MARKERS) {
    graphOk.push(
      check(
        `${marker}: present in the Node server graph (positive control)`,
        filesWith(serverJs, marker).length > 0,
      ),
    );
  }

  const browserSources = mapSources(browser);
  const serverSourcesInBrowser = browserSources.filter(
    (source) =>
      FULL_STACK_SERVER_SOURCES.some(
        (file) => source.endsWith(file) && !source.includes("/generated/"),
      ) || /@strata-sc\/(core|analog)\/|\/src\/server\//.test(source),
  );

  console.log(`browser source maps: ${browserSources.length} sources`);
  graphOk.push(
    check("browser source maps exist (the graph check is not vacuous)", browserSources.length > 20),
    check(
      "browser source maps name none of the consumer's server files and neither @strata-sc/core nor @strata-sc/analog",
      serverSourcesInBrowser.length === 0,
      serverSourcesInBrowser.join(", "),
    ),
    check(
      "browser source maps include the island and the generated surrogate, and the packed server-components runtime",
      browserSources.some((s) => s.endsWith("product-availability.component.ts")) &&
        browserSources.some((s) =>
          s.includes("generated/server-components/products/product-details.server-component.ts"),
        ) &&
        browserSources.some((s) =>
          s.includes("node_modules/@strata-sc/server-components/dist/fesm2022/"),
        ) &&
        !browserSources.some((s) => /packages\/server-components|\/Strata\//.test(s)),
    ),
    check(
      "no controller, adapter or registration code in any browser script",
      ["registerControllers", "getControllerDefinition", "ProductsController", "nitropack"].every(
        (needle) => filesWith(browserJs, needle).length === 0,
      ),
    ),
    check(
      `${FULL_STACK_MARKERS.client}: present in the browser graph (positive control)`,
      filesWith(browserJs, FULL_STACK_MARKERS.client).length > 0,
    ),
  );

  const serverMaps = mapSources(server);

  graphOk.push(
    check(
      "server output includes the consumer's server-only Angular sources (source-map positive control)",
      ["product.repository.ts", "server-helper.ts", "product-details.server-component.ts"].every(
        (file) => serverMaps.some((s) => s.endsWith(file)),
      ),
    ),
  );

  const controllerChunks = filesWith(serverJs, "ProductsController");
  const controllerSource = controllerChunks.map((f) => readFileSync(dist(f), "utf8")).join("\n");

  graphOk.push(
    check(
      "the controller is in the Nitro server bundle, lowered from STANDARD decorators (no legacy __decorate, no reflect-metadata)",
      controllerChunks.length > 0 &&
        /__decorateElement|__esDecorate/.test(controllerSource) &&
        !/__decorate\(|__metadata\(|Reflect\.metadata|reflect-metadata/.test(controllerSource),
      controllerChunks.join(", "),
    ),
  );

  // ------------------------------------------------------------------------
  section("Production Node server: controller API, SSR, hydration, interaction, navigation");

  const node = await timeAsync("start production server", () => startNodeServer(consumerDir, env));

  servers.push(node);

  const nodeHttp = await httpSuite(node.baseUrl, "node", () => node.output());
  const nodeIsland = await islandSuite(node.baseUrl, "node");
  const nodeNavigation = await navigationSuite(node.baseUrl, "node");

  await node.stop();
  servers.length = 0;

  const nodeAll = [...nodeHttp, ...nodeIsland.ok, ...nodeNavigation, ...graphOk];

  verdict.node = all(nodeAll);
  verdict.controllerIntegration = all(nodeHttp.slice(0, 9));
  verdict.serverComponents = all(nodeHttp.slice(9));
  verdict.island = all([...nodeIsland.ok, ...nodeNavigation]);
  verdict.confidentiality = all(graphOk) && all(nodeIsland.ok);

  // ------------------------------------------------------------------------
  section("server-only firewall from the installed plugin (production build)");

  const firewall: boolean[] = [];
  const island = join(consumerDir, "src", "app", "products", "product-availability.component.ts");

  restoreDir(consumerDir, pristine, NOT_SOURCE);
  writeFileSync(
    island,
    `import { ProductRepository } from "./product.repository";\n${readFileSync(
      island,
      "utf8",
    ).replace(
      "protected readonly marker = CLIENT_MARKER;",
      "protected readonly marker = CLIENT_MARKER;\n  protected readonly leak = ProductRepository.name;",
    )}`,
  );
  clean();

  const illegal = vite(["build"]);
  const output = sanitize(`${illegal.stdout}\n${illegal.stderr}`);

  firewall.push(
    check(
      "an island importing the server-only repository fails the production build",
      illegal.status !== 0,
      output.slice(-600),
    ),
    check(
      "the diagnostic comes from the installed plugin and names the consumer importer and the fix",
      /\[strata\] Server-only module entered the browser graph: src\/app\/products\/product\.repository\.ts/.test(
        output,
      ) &&
        /Imported from: src\/app\/products\/product-availability\.component\.ts/.test(output) &&
        /Move the dependency behind the Server Component boundary/.test(output),
      output.match(/\[strata\][^\n]*/)?.[0] ?? "",
    ),
    check(
      "the diagnostic prints no marker, no repository path and no module contents",
      PRIVATE_CANARIES.every((c) => !output.includes(c)) && !output.includes(repoRoot),
    ),
  );
  restoreDir(consumerDir, pristine, NOT_SOURCE);
  clean();

  const restoredProblems = snapshotDiffers(consumerDir, pristine, NOT_SOURCE);

  firewall.push(
    check(
      "the consumer sources are back to their original bytes after the failing scenario",
      restoredProblems.length === 0,
      restoredProblems.join(", "),
    ),
  );
  verdict.firewall = all(firewall);

  // ------------------------------------------------------------------------
  section("External Cloudflare Pages build and workerd (consumer-installed wrangler)");

  const cfOk: boolean[] = [];

  build("consumer `vite build` with BUILD_PRESET=cloudflare-pages", {
    BUILD_PRESET: "cloudflare-pages",
  });

  const nitroMeta = JSON.parse(readFileSync(dist("analog", "nitro.json"), "utf8")) as {
    preset?: string;
  };
  const workerDir = dist("analog", "public", "_worker.js");
  const worker = moduleGraph(workerDir, "index.js");
  const workerJs = worker.modules.map((module) => `analog/public/_worker.js/${module}`);
  const publicAssets = graphFiles(["analog/public", "client"], (file) =>
    file.startsWith("analog/public/_worker.js/"),
  );

  console.log(
    `Worker: ${worker.modules.length} reachable modules; compatibility date ${COMPATIBILITY_DATE}; flags: (none; nodejs_compat NOT enabled)`,
  );
  cfOk.push(
    check(
      "the build resolves the cloudflare-pages preset",
      nitroMeta.preset === "cloudflare-pages",
      String(nitroMeta.preset),
    ),
    check(
      "a Worker was built (analog/public/_worker.js/index.js)",
      existsSync(join(workerDir, "index.js")),
    ),
  );
  for (const marker of SERVER_ONLY_MARKERS) {
    cfOk.push(
      check(
        `${marker}: in the Worker graph`,
        workerJs.some((file) => readFileSync(dist(file), "utf8").includes(marker)),
      ),
    );
  }
  for (const marker of PRIVATE_CANARIES) {
    cfOk.push(
      check(
        `${marker}: absent from the public browser assets and maps`,
        filesWith(publicAssets, marker).length === 0,
        filesWith(publicAssets, marker).join(", "),
      ),
    );
  }

  const publicSources = mapSources(publicAssets);

  cfOk.push(
    check(
      "public source maps name none of the consumer's server files, @strata-sc/core or @strata-sc/analog",
      !publicSources.some(
        (source) =>
          FULL_STACK_SERVER_SOURCES.some(
            (file) => source.endsWith(file) && !source.includes("/generated/"),
          ) || /@strata-sc\/(core|analog)\/|\/src\/server\//.test(source),
      ),
    ),
    check(
      "the Worker's unresolved imports are not Node built-ins (nodejs_compat is not enabled)",
      worker.externals.every(({ specifier }) => specifier.startsWith("node:") === false),
      worker.externals.map((e) => e.specifier).join(", "),
    ),
  );

  const wrangler = await timeAsync("start wrangler pages dev", () =>
    startWrangler(consumerDir, env, "/products/42"),
  );

  servers.push(wrangler);
  console.log(`wrangler (consumer-installed): ${installedVersion(consumerDir, "wrangler")}`);

  const cfHttp = await httpSuite(wrangler.baseUrl, "workerd", () => wrangler.output());
  const cfIsland = await islandSuite(wrangler.baseUrl, "workerd");
  const cfNavigation = await navigationSuite(wrangler.baseUrl, "workerd");

  cfOk.push(
    ...cfHttp,
    ...cfIsland.ok,
    ...cfNavigation,
    check(
      "workerd: no code-generation or JIT error in the runtime log",
      !/Code generation from strings disallowed|JIT compilation|needs to be compiled using the JIT/.test(
        sanitize(wrangler.output()),
      ),
      sanitize(wrangler.output()).slice(-600),
    ),
  );
  await wrangler.stop();
  servers.length = 0;
  verdict.cloudflare = all(cfOk);

  // ------------------------------------------------------------------------
  section("The template and the packages are untouched");

  const templateNow = snapshotDiffers(fixtureTemplate, templateBefore, () => false);

  check(
    "the fixture template in the repository is unchanged",
    templateNow.length === 0,
    templateNow.join(", "),
  );
  check(
    "no package manifest changed during the qualification",
    PACKAGES.every(
      (pkg, index) =>
        readManifest(join(repoRoot, pkg.dir)).version === manifests[index]!.manifest.version,
    ),
  );
} catch (error) {
  if (!(error instanceof Abort)) {
    check(
      "the qualification ran to completion",
      false,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
} finally {
  for (const server of servers) await server.stop().catch(() => undefined);

  console.log(`\ntimings: ${timings.join("; ")}`);

  if (process.env["STRATA_KEEP_CONSUMER"] === "1") {
    console.log(`kept: ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

section("Verdict");
check("external packed-package installation", verdict.install);
check("declaration portability (TypeScript 5.9.2)", verdict.declarations59);
check("declaration portability (TypeScript 6)", verdict.declarations6);
check("Core + Analog controller integration (Node)", verdict.controllerIntegration);
check("Server Components integration (Node)", verdict.serverComponents);
check("interactive island + controller HTTP API + navigation (Node)", verdict.island);
check("Node production consumer", verdict.node);
check("server-only firewall from the installed plugin", verdict.firewall);
check("Cloudflare/workerd consumer", verdict.cloudflare);
check("graph confidentiality", verdict.confidentiality);

void until;
finish(TITLE);
