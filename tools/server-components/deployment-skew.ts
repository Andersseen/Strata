import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { httpGet } from "../analog/lib/process.ts";
import { run } from "../consumer/lib/exec.ts";

import { SERVER_MARKERS } from "./lib/consumer-fixture.ts";
import {
  RELEASES,
  Edge,
  entryScript,
  filesContaining,
  isolated,
  sanitize,
  buildRelease,
} from "./lib/deployment-skew.ts";
import type { BuiltRelease, Plan, Release, Rewrite } from "./lib/deployment-skew.ts";
import { check, finish, repoRoot, section } from "./lib/harness.ts";
import { startNodeServer, startWrangler } from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";

/**
 * `pnpm test:server-component-deployment-skew`: Server Components 0.8.0
 * deployment compatibility, qualified with REAL, independently built releases
 * of an external consumer that installs the PACKED package
 * (docs/research/server-component-deployment-skew-v08.md).
 *
 *   release A  buildId rel-2026.10.1
 *   release B  buildId rel-2026.10.2, a renamed client input and another server message
 *   legacy     release A's sources built without the option
 *
 * An "edge" serves a document from one release and the browser script from
 * another, so every mismatch is a pair of genuine production artifacts. The
 * few scenarios that edit a served document are labelled negative controls and
 * are never the evidence for the two-build claims.
 *
 * `STRATA_SKEW_RUNTIMES=node,cloudflare` (default both) selects Nitro Node and
 * local workerd (`wrangler pages dev`; not a deployed Pages project).
 */

const TITLE = "server-component deployment skew qualification";
const PACKAGE = "@strata-sc/server-components";
const WIDGETS_PACKAGE = "@strata-test/angular-widgets";
const KIT_PACKAGE = "@strata-test/kit";
const root = join(repoRoot, "tests", "server-component-package-consumer");
const packageDir = join(repoRoot, "packages", "server-components");
const runtimes = (process.env["STRATA_SKEW_RUNTIMES"] ?? "node,cloudflare").split(",");

// STRATA_SKEW_REUSE=<kept tmp root> re-runs the scenarios on already built releases (development only).
const reuse = process.env["STRATA_SKEW_REUSE"];
const tmpRoot = reuse ?? mkdtempSync(join(tmpdir(), "strata-deployment-skew-"));
const consumerDir = join(tmpRoot, "consumer");
const releasesDir = join(tmpRoot, "releases");
const env = isolated(tmpRoot);
const servers: RunningServer[] = [];
let browser: Browser | undefined;
let edge: Edge | undefined;

const must = (result: ReturnType<typeof run>, label: string): void => {
  if (result.status === 0) return;
  throw new Error(`${label} failed:\n${sanitize(result.stderr || result.stdout).slice(-3000)}`);
};

// ---------------------------------------------------------------------------
// Browser observation

interface Observed {
  readonly hosts: number;
  readonly hydratedHosts: number;
  readonly hydrated: number;
  readonly errors: readonly {
    name: string;
    category: string | null;
    recovery: string | null;
    message: string;
  }[];
  readonly mismatches: readonly { browserBuildId: string; serverBuildId: string }[];
  readonly hydrationObservations: readonly {
    hostSelector: string;
    outcome: string;
    discoveredBoundaries: number;
    committedBoundaries: number;
    failureCategory?: string;
    buildMismatch: boolean;
    recoveryOutcome?: string;
  }[];
  readonly record: string | null;
  readonly sameNodes: boolean;
  readonly messages: readonly string[];
}

const OBSERVE = `(() => {
  const hosts = [...document.querySelectorAll("product-details")];
  const text = (host) => host.querySelector("#server-message")?.textContent ?? "";
  let record = null;
  try { record = sessionStorage.getItem("strata:skew-recovery"); } catch { record = "(unavailable)"; }
  const nodes = window.__ssrNodes ?? [];
  const now = [...document.querySelectorAll("add-to-cart button[data-product-id]")];
  return {
    hosts: hosts.length,
    hydratedHosts: hosts.filter((host) => host.querySelector("[data-strata-hydrated]")).length,
    hydrated: document.querySelectorAll("[data-strata-hydrated]").length,
    errors: window.__strataErrors ?? [],
    mismatches: window.__strataMismatches ?? [],
    hydrationObservations: window.__STRATA_HYDRATION_OBSERVATIONS__ ?? [],
    record,
    sameNodes: nodes.length > 0 && nodes.length === now.length && nodes.every((n, i) => n === now[i] && n.isConnected),
    messages: hosts.map(text),
  };
})()`;

const CAPTURE_SSR_NODES = `
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive") {
      window.__ssrNodes = [...document.querySelectorAll("add-to-cart button[data-product-id]")];
    }
  });`;

const poll = async <T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = 45_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await Promise.resolve()
      .then(read)
      .catch(() => undefined);

    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};

const observe = (page: Page): Promise<Observed> => page.evaluate(OBSERVE);

/** Every Server Component host accounted for: hydrated, or reported as a failure by the ErrorHandler. */
const settled = (page: Page, hosts: number) =>
  poll(async () => {
    const seen = await observe(page);

    return seen.hosts >= hosts && seen.hydratedHosts + seen.errors.length >= hosts
      ? seen
      : undefined;
  }, `${hosts} host(s) hydrated or refused`);

interface Visit {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly console: string[];
  readonly documents: string[];
  close(): Promise<void>;
}

async function visit(extraInit = ""): Promise<Visit> {
  const context = await browser!.newContext();
  const page = await context.newPage();
  const consoleLines: string[] = [];
  const documents: string[] = [];

  await context.addInitScript(CAPTURE_SSR_NODES + extraInit);
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      consoleLines.push(message.text());
  });
  page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.request().resourceType() === "document") documents.push(response.url());
    if (process.env["STRATA_SKEW_TRACE"] && response.request().resourceType() === "script")
      console.log("   script", response.url(), response.status());
  });

  return { page, context, console: consoleLines, documents, close: () => context.close() };
}

const HEALTHY_PER_HOST = 4; // add-to-cart, two package pickers, legacy-counter

async function interactive(page: Page, host = 0): Promise<boolean> {
  const before = await page
    .locator("product-details")
    .nth(host)
    .locator("add-to-cart output:not(#stock)")
    .innerText();

  await page
    .locator("product-details")
    .nth(host)
    .locator("add-to-cart button[data-product-id]")
    .click();

  return poll(async () => {
    const after = await page
      .locator("product-details")
      .nth(host)
      .locator("add-to-cart output:not(#stock)")
      .innerText();

    return after !== before && /Count: 1/.test(after) ? true : undefined;
  }, "the island reacts to a click").catch(() => false);
}

async function inert(page: Page, host = 0): Promise<boolean> {
  const output = page
    .locator("product-details")
    .nth(host)
    .locator("add-to-cart output:not(#stock)");
  const before = await output.innerText();

  await page
    .locator("product-details")
    .nth(host)
    .locator("add-to-cart button[data-product-id]")
    .click();
  await page.waitForLoadState("networkidle");

  return (await output.innerText()) === before && /Count: 0/.test(before);
}

const PRODUCT = "/product";
const same = (release: Release): Plan => ({ html: release, assets: release });

// ---------------------------------------------------------------------------

try {
  section("Build and pack the real package, an Angular partial library and a plain kit");

  if (!reuse) {
    rmSync(join(packageDir, "dist"), { recursive: true, force: true });
    must(run("pnpm", ["--filter", PACKAGE, "run", "build"], { cwd: repoRoot }), "package build");

    const tarballs = join(tmpRoot, "tarballs");
    mkdirSync(tarballs, { recursive: true });
    must(run("pnpm", ["pack", "--pack-destination", tarballs], { cwd: packageDir }), "pnpm pack");

    const packed = (directory: string): string =>
      join(
        directory,
        readdirSync(directory).find((name) => name.endsWith(".tgz"))!,
      );
    const tarball = packed(tarballs);
    const npmFlags = [
      "--cache",
      join(tmpRoot, "npm-cache"),
      "--logs-dir",
      join(tmpRoot, "npm-logs"),
    ];

    const widgetsDir = join(tmpRoot, "angular-widgets");
    const widgetsTarballs = join(tmpRoot, "widgets-tarballs");
    cpSync(join(root, "angular-widgets"), widgetsDir, { recursive: true });
    mkdirSync(widgetsTarballs, { recursive: true });
    symlinkSync(join(packageDir, "node_modules"), join(widgetsDir, "node_modules"), "dir");
    must(
      run("pnpm", ["--filter", PACKAGE, "exec", "ngc", "-p", join(widgetsDir, "tsconfig.json")], {
        cwd: repoRoot,
      }),
      "ngc partial-compiles the widgets",
    );
    must(
      run("npm", ["pack", "--pack-destination", widgetsTarballs, ...npmFlags], { cwd: widgetsDir }),
      "npm pack widgets",
    );

    const kitDir = join(tmpRoot, "kit");
    const kitTarballs = join(tmpRoot, "kit-tarballs");
    cpSync(join(root, "kit"), kitDir, { recursive: true });
    mkdirSync(kitTarballs, { recursive: true });
    must(
      run("npm", ["pack", "--pack-destination", kitTarballs, ...npmFlags], { cwd: kitDir }),
      "npm pack kit",
    );

    section("External install (npm, outside the workspace)");

    cpSync(join(root, "fixture"), consumerDir, { recursive: true });

    const manifestPath = join(consumerDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
    };

    manifest.dependencies[PACKAGE] = `file:${tarball}`;
    manifest.dependencies[WIDGETS_PACKAGE] = `file:${packed(widgetsTarballs)}`;
    manifest.dependencies[KIT_PACKAGE] = `file:${packed(kitTarballs)}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    must(
      run(
        "npm",
        [
          "install",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
          ...npmFlags,
          "--fetch-retries=0",
        ],
        {
          cwd: consumerDir,
          env,
        },
      ),
      "npm install",
    );
    check("the consumer lives outside the repository", !consumerDir.startsWith(repoRoot));
  }

  browser = await chromium.launch();

  for (const runtime of runtimes) {
    const preset = runtime === "cloudflare" ? "cloudflare" : "node";
    const label =
      runtime === "cloudflare" ? "workerd (local wrangler pages dev)" : "Nitro Node production";

    section(`${label}: build releases A, B and legacy from independent builds`);

    const built = new Map<Release, BuiltRelease>();

    for (const release of ["a", "b", "legacy"] as const) {
      const kept = join(releasesDir, `${preset}-${release}`);
      const result = reuse
        ? { release, directory: kept, output: "" }
        : buildRelease({ consumerDir, releasesDir, release, preset, env });

      built.set(release, result);
      check(`release ${release} builds (${RELEASES[release].buildId ?? "no buildId"})`, true);
    }

    section(`${label}: start the three releases behind one edge`);

    const upstreams = {} as Record<Release, string>;

    for (const release of ["a", "b", "legacy"] as const) {
      const directory = built.get(release)!.directory;
      const server =
        runtime === "cloudflare"
          ? await startWrangler(directory, env)
          : await startNodeServer(directory, env);

      servers.push(server);
      upstreams[release] = server.baseUrl;
    }

    const documents = {} as Record<Release, string>;
    const entries = {} as Record<Release, string>;

    for (const release of ["a", "b", "legacy"] as const) {
      const reply = await httpGet(`${upstreams[release]}${PRODUCT}`);

      documents[release] = reply.body;
      entries[release] = entryScript(reply.body) ?? "";
    }

    const entryBodies = await Promise.all(
      (["a", "b", "legacy"] as const).map(
        async (release) => (await httpGet(`${upstreams[release]}/assets/entry.js`)).body,
      ),
    );

    check(
      "all releases name one stable browser entry URL whose content differs per release",
      Object.values(entries).every((entry) => entry === "/assets/entry.js") &&
        new Set(entryBodies).size === 3 &&
        entryBodies.every((body) => body.length > 10_000),
      JSON.stringify(entries),
    );

    // The raw server output of every release: complete SSR, and the stamp or its absence.
    for (const release of ["a", "b", "legacy"] as const) {
      const html = documents[release];
      const id = RELEASES[release].buildId;
      const stamps = [...html.matchAll(/data-strata-build="([^"]*)"/g)].map((m) => m[1]);
      const protocols = [...html.matchAll(/data-strata-protocol="([^"]*)"/g)].map((m) => m[1]);

      check(
        `release ${release}: complete SSR document (heading, message, evidence, package island)`,
        html.includes("<h1>Product 42</h1>") &&
          html.includes(`>${RELEASES[release].message}</p>`) &&
          /data-evidence="[^"]+"/.test(html) &&
          html.includes("STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT"),
      );
      check(
        `release ${release}: every one of the 4 boundaries ${id ? `carries data-strata-build="${id}"` : "carries no build attribute"}; protocols stay "1"/"2"`,
        (id ? stamps.length === 4 && stamps.every((value) => value === id) : stamps.length === 0) &&
          protocols.length === 4 &&
          protocols.every((value) => value === "1" || value === "2"),
        `${stamps.join(",")} / ${protocols.join(",")}`,
      );
    }
    check(
      "release B really is a different application contract: its client input is `item`, A's is `product`",
      /product&quot;|&quot;product&quot;/.test(documents.a) &&
        !/&quot;item&quot;/.test(documents.a) &&
        /&quot;item&quot;/.test(documents.b),
    );

    edge = new Edge({ upstreams });
    await edge.start();

    const url = (path = PRODUCT): string => `${edge!.baseUrl}${path}`;

    // -----------------------------------------------------------------------
    section(`${label}: matched builds hydrate (1, 2, 7, 8, 18)`);

    for (const release of ["a", "b"] as const) {
      edge.scenario([same(release)]);
      const v = await visit();

      await v.page.goto(url());
      const seen = await settled(v.page, 1);

      check(
        `${release.toUpperCase()} document + ${release.toUpperCase()} script: 4 boundaries hydrate over the SSR nodes, no error, v1 and v2 islands`,
        seen.hydrated === HEALTHY_PER_HOST &&
          seen.errors.length === 0 &&
          seen.sameNodes &&
          seen.mismatches.length === 0,
        JSON.stringify(seen),
      );
      check(`${release.toUpperCase()}: the island is interactive`, await interactive(v.page));
      check(
        `${release.toUpperCase()}: no console error`,
        v.console.length === 0,
        v.console.join(" | "),
      );
      check(`${release.toUpperCase()}: one document request`, edge.requests.length === 1);
      await v.close();
    }

    edge.scenario([same("a")]);
    {
      const v = await visit();

      await v.page.goto(url("/pair"));
      const seen = await settled(v.page, 2);
      const total = await v.page.locator("[data-strata-client]").count();

      check(
        "two hosts of one build, identical selectors and props: all 8 boundaries hydrate on their own hosts",
        seen.hosts === 2 &&
          seen.hydratedHosts === 2 &&
          seen.hydrated === 2 * HEALTHY_PER_HOST &&
          total === 2 * HEALTHY_PER_HOST &&
          seen.errors.length === 0 &&
          seen.sameNodes,
        JSON.stringify(seen),
      );
      check(
        "both hosts are interactive and independent",
        (await interactive(v.page, 0)) && (await interactive(v.page, 1)),
      );
      await v.close();
    }

    // -----------------------------------------------------------------------
    section(`${label}: a document and a script from different builds are recognised (3, 4, 5, 10)`);

    const classified = (
      error: Observed["errors"][number] | undefined,
      browserId: string,
      serverId: string,
    ): boolean =>
      error?.name === "StrataBuildMismatchError" &&
      error.category === "build-mismatch" &&
      error.message.includes(`"${browserId}"`) &&
      error.message.includes(`"${serverId}"`);

    for (const [html, assets] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      edge.scenario([{ html, assets }]);
      const v = await visit();

      await v.page.goto(url());
      const seen = await settled(v.page, 1);
      const browserId = RELEASES[assets].buildId!;
      const serverId = RELEASES[html].buildId!;

      check(
        `${html.toUpperCase()} document + ${assets.toUpperCase()} script: refused as build-mismatch naming both builds, nothing hydrates`,
        seen.hydrated === 0 &&
          seen.errors.length === 1 &&
          classified(seen.errors[0], browserId, serverId),
        JSON.stringify(seen.errors),
      );
      check(
        "confirmed mismatch emits one classified preflight observation with recovery outcome",
        seen.hydrationObservations.length === 1 &&
          seen.hydrationObservations[0]?.outcome === "preflight-refused" &&
          seen.hydrationObservations[0]?.failureCategory === "build-mismatch" &&
          seen.hydrationObservations[0]?.buildMismatch === true &&
          seen.hydrationObservations[0]?.recoveryOutcome === "disabled" &&
          seen.hydrationObservations[0]?.committedBoundaries === 0,
        JSON.stringify(seen.hydrationObservations),
      );
      check(
        "the consumer callback received the two public build ids",
        JSON.stringify(seen.mismatches) ===
          JSON.stringify([{ browserBuildId: browserId, serverBuildId: serverId }]),
        JSON.stringify(seen.mismatches),
      );
      check(
        "recovery is disabled by default: the error says so, no reload, no storage written",
        seen.errors[0]?.recovery === "disabled" &&
          seen.record === null &&
          edge.requests.length === 1,
      );
      check(
        "the server-rendered DOM stays visible and inert",
        seen.messages[0] === RELEASES[html].message && (await inert(v.page)),
      );
      await v.page.waitForLoadState("networkidle");
      check(
        "still exactly one document request",
        edge.requests.length === 1 && v.documents.length === 1,
      );
      check(
        "the ErrorHandler line carries no source path, prop value or server marker",
        v.console.every(
          (line) =>
            !SERVER_MARKERS.some((marker) => line.includes(marker)) && !line.includes(tmpRoot),
        ),
      );
      await v.close();
    }

    // -----------------------------------------------------------------------
    section(
      `${label}: protocol evidence is not build evidence; a mismatch outranks an input rename (5, 6)`,
    );

    {
      edge.scenario([{ html: "b", assets: "a" }]);
      const v = await visit();

      await v.page.goto(url());
      const seen = await settled(v.page, 1);
      const protocols = [...documents.b.matchAll(/data-strata-protocol="([^"]*)"/g)].map(
        (m) => m[1],
      );

      check(
        "B's markup uses a protocol A's runtime fully supports (1 and 2), yet A refuses it as a BUILD mismatch, not an input error",
        protocols.every((value) => value === "1" || value === "2") &&
          seen.errors[0]?.category === "build-mismatch" &&
          !/is not an input of the component/.test(seen.errors[0]?.message ?? ""),
      );
      await v.close();
    }

    const protocolNine: Rewrite = (html) =>
      html.replaceAll('data-strata-protocol="2"', 'data-strata-protocol="9"');

    edge.scenario([same("a")], { rewrite: protocolNine });
    {
      const v = await visit("");

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      const seen = await settled(v.page, 1);

      check(
        "NEGATIVE CONTROL (edited protocol, same build): an unsupported protocol is its own class, never a skew, never a reload",
        seen.hydrated === 0 &&
          seen.errors[0]?.category === "protocol" &&
          seen.errors[0]?.name === "StrataBoundaryError" &&
          seen.mismatches.length === 0 &&
          seen.record === null &&
          edge.requests.length === 1,
        JSON.stringify(seen.errors),
      );
      await v.close();
    }

    // -----------------------------------------------------------------------
    section(`${label}: a pre-feature or tampered identity is not a deployment (15)`);

    {
      edge.scenario([{ html: "legacy", assets: "a" }]);
      const v = await visit();

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      const seen = await settled(v.page, 1);

      check(
        "LEGACY document (never opted in) + A script: refused as build-identity (missing), not as a mismatch, and recovery never runs",
        seen.hydrated === 0 &&
          seen.errors[0]?.category === "build-identity" &&
          seen.mismatches.length === 0 &&
          seen.record === null &&
          edge.requests.length === 1,
        JSON.stringify(seen.errors),
      );
      await v.close();
    }
    {
      edge.scenario([{ html: "a", assets: "legacy" }]);
      const v = await visit();

      await v.page.goto(url());
      const seen = await settled(v.page, 1);

      check(
        "A document + LEGACY script (no enforcement): hydrates exactly as before the feature; the stamp is ignored",
        seen.hydrated === HEALTHY_PER_HOST && seen.errors.length === 0 && seen.sameNodes,
        JSON.stringify(seen),
      );
      await v.close();
    }
    {
      edge.scenario([same("legacy")]);
      const v = await visit();

      await v.page.goto(url());
      const seen = await settled(v.page, 1);

      check(
        "LEGACY + LEGACY (feature off everywhere): unchanged v1/v2 hydration",
        seen.hydrated === HEALTHY_PER_HOST && seen.errors.length === 0 && seen.sameNodes,
      );
      await v.close();
    }
    for (const [name, rewrite] of [
      [
        "an empty attribute",
        (html: string) => html.replaceAll(/data-strata-build="[^"]*"/g, 'data-strata-build=""'),
      ],
      [
        "markup in the attribute",
        (html: string) =>
          html.replaceAll(
            /data-strata-build="[^"]*"/g,
            'data-strata-build="&lt;img src=x onerror=1&gt;"',
          ),
      ],
    ] as const) {
      edge.scenario([same("a")], { rewrite });
      const v = await visit();

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      const seen = await settled(v.page, 1);

      check(
        `NEGATIVE CONTROL (${name}): malformed identity is build-identity, not skew; no reload even with recovery on`,
        seen.hydrated === 0 &&
          seen.errors[0]?.category === "build-identity" &&
          !seen.errors[0].message.includes("onerror") &&
          seen.record === null &&
          edge.requests.length === 1,
        JSON.stringify(seen.errors),
      );
      await v.close();
    }

    // -----------------------------------------------------------------------
    section(`${label}: one incompatible host beside healthy hosts (9)`);

    edge.scenario([{ html: "a", assets: "a" }], { splice: { path: "/pair", host: 1, from: "b" } });
    {
      const v = await visit();

      await v.page.goto(url("/pair"));
      const seen = await settled(v.page, 2);

      check(
        "host 1 (A) hydrates its 4 boundaries over SSR nodes; host 2 (rendered by B) is refused as a mismatch and left inert",
        seen.hydratedHosts === 1 &&
          seen.hydrated === HEALTHY_PER_HOST &&
          seen.errors.length === 1 &&
          classified(seen.errors[0], RELEASES.a.buildId!, RELEASES.b.buildId!),
        JSON.stringify(seen),
      );
      check(
        "the healthy sibling stays interactive; the refused host stays inert",
        (await interactive(v.page, 0)) && (await inert(v.page, 1)),
      );
      check("no reload without opt-in", edge.requests.length === 1);
      await v.close();
    }

    // -----------------------------------------------------------------------
    section(`${label}: opt-in recovery (11, 12, 13, 16)`);

    edge.scenario([{ html: "a", assets: "b" }, same("b")]);
    {
      const v = await visit();

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      await poll(
        () => (edge!.requests.length >= 2 ? true : undefined),
        "the single recovery reload",
      );
      const seen = await settled(v.page, 1);

      check(
        "A document + B script, recovery on, CDN converges: one reload to a compatible B document, 4 boundaries hydrate",
        edge.requests.length === 2 &&
          edge.requests[1]!.plan.html === "b" &&
          seen.hydrated === HEALTHY_PER_HOST &&
          seen.errors.length === 0 &&
          seen.messages[0] === RELEASES.b.message &&
          seen.sameNodes,
        JSON.stringify({ requests: edge.requests, seen }),
      );
      check(
        "the reload targets the same URL: no redirect target is computed or stored",
        edge.requests.every((request) => request.path === `${PRODUCT}?recovery=reload`),
      );
      check(
        "the tab record holds only a counter and a timestamp: no URL, no build id, no markup",
        /^\{"count":1,"since":\d+\}$/.test(seen.record ?? ""),
        seen.record ?? "",
      );
      check("the recovered island is interactive", await interactive(v.page));
      await v.close();
    }

    edge.scenario([{ html: "a", assets: "b" }]);
    {
      const v = await visit();

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      await poll(
        () => (edge!.requests.length >= 2 ? true : undefined),
        "the single recovery reload",
      );
      const seen = await poll(async () => {
        const observed = await observe(v.page);

        return observed.errors.length > 0 && edge!.requests.length >= 2 ? observed : undefined;
      }, "the second, still mismatched document to be refused");

      await v.page.waitForLoadState("networkidle");
      check(
        "persistent mismatch, recovery on: exactly one reload, then the error says `exhausted` and the page stays in its inert SSR state",
        edge.requests.length === 2 &&
          seen.errors.length === 1 &&
          seen.errors[0]!.recovery === "exhausted" &&
          seen.hydrated === 0 &&
          (await inert(v.page)),
        JSON.stringify({ requests: edge.requests.length, errors: seen.errors }),
      );

      // 13: a user-initiated reload inside the window does not earn another automatic one.
      await v.page.reload();
      const again = await settled(v.page, 1);

      await v.page.waitForLoadState("networkidle");
      check(
        "a manual reload inside the window is not followed by another automatic reload",
        again.errors[0]?.recovery === "exhausted" && edge.requests.length === 3,
        `${again.errors[0]?.recovery} ${edge.requests.length}`,
      );
      await v.close();
    }

    edge.scenario([{ html: "a", assets: "b" }]);
    {
      const v = await visit(
        `sessionStorage.setItem("strata:skew-recovery", JSON.stringify({ count: 1, since: Date.now() }));`,
      );

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      const seen = await settled(v.page, 1);

      await v.page.waitForLoadState("networkidle");
      check(
        "attempted repeated reload (the tab already used its attempt): never reloads",
        seen.errors[0]?.recovery === "exhausted" && edge.requests.length === 1,
      );
      await v.close();
    }
    for (const [name, init] of [
      [
        "sessionStorage throws",
        `Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("denied", "SecurityError"); } });`,
      ],
      ["sessionStorage accepts and forgets writes", `Storage.prototype.setItem = function () {}; `],
    ] as const) {
      edge.scenario([{ html: "a", assets: "b" }]);
      const v = await visit(init);

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      const seen = await poll(async () => {
        const observed = await observe(v.page);

        return observed.errors.length > 0 ? observed : undefined;
      }, "the mismatch to be reported");

      await v.page.waitForLoadState("networkidle");
      check(
        `${name}: recovery fails closed as storage-unavailable and never reloads`,
        seen.errors[0]?.recovery === "storage-unavailable" && edge.requests.length === 1,
        JSON.stringify(seen.errors),
      );
      await v.close();
    }

    // -----------------------------------------------------------------------
    section(`${label}: rollback B → A, document navigation, Back and Forward (14, 17)`);

    edge.scenario([same("b")]);
    {
      const v = await visit();

      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      const first = await settled(v.page, 1);

      check(
        "B is live and healthy",
        first.hydrated === HEALTHY_PER_HOST && first.messages[0] === RELEASES.b.message,
      );

      await v.page.goto(url("/about"));
      // Roll back: the next product document is A's while this tab keeps B's script (the stale
      // entry), then the edge converges on A for everything.
      edge.next([{ html: "a", assets: "b" }, same("a")]);
      await v.page.goto(url(`${PRODUCT}?recovery=reload`));
      await poll(
        () => (edge!.requests.length >= 4 ? true : undefined),
        "the rollback recovery reload",
      );
      const rolled = await settled(v.page, 1);

      check(
        "rollback with a stale B script: the A document is recognised, one reload, A hydrates",
        rolled.hydrated === HEALTHY_PER_HOST &&
          rolled.errors.length === 0 &&
          rolled.messages[0] === RELEASES.a.message,
        JSON.stringify(rolled),
      );
      check(
        "the rollback never needed more than the one bounded reload",
        edge.requests.filter((r) => r.path.startsWith(PRODUCT)).length === 3,
      );

      await v.page.goBack();
      await v.page.waitForLoadState("load");
      check("Back reaches the about document", new URL(v.page.url()).pathname === "/about");
      await v.page.goForward();
      const forward = await settled(v.page, 1);

      check(
        "Forward returns to a hydrated product page (restored or re-fetched), not a stale inert one",
        forward.hydrated === HEALTHY_PER_HOST && forward.errors.length === 0,
        JSON.stringify(forward),
      );
      await v.close();
    }

    // -----------------------------------------------------------------------
    section(`${label}: confidentiality`);

    const clientRoots = ["client", "analog/public"];
    // The public surrogate chunk legitimately carries the server component's file name, so only the
    // server-owned modules and every server marker count as leaks.
    const needles = [...SERVER_MARKERS, "product.repository", "server-helper"];

    for (const release of ["a", "b", "legacy"] as const) {
      const directory = join(built.get(release)!.directory, "dist");
      const leaks = filesContaining(directory, clientRoots, needles).filter(
        (file) => !file.includes("_worker.js"),
      );

      check(
        `release ${release}: no server marker or server source name in client JavaScript, assets or source maps`,
        leaks.length === 0,
        leaks.join(", "),
      );
    }
    {
      const id = RELEASES.a.buildId!;
      const hits = filesContaining(join(built.get("a")!.directory, "dist"), clientRoots, [
        id,
      ]).filter((file) => !file.includes("_worker.js"));
      const sourceMaps = hits.filter((file) => file.endsWith(".map"));

      check(
        "the build id is present in the browser script (positive control) and is the only deployment datum",
        hits.length > 0,
        hits.join(", "),
      );
      check(
        "the public build id never appears in a source map's sources",
        sourceMaps.every(
          (file) =>
            !readFileSync(join(built.get("a")!.directory, "dist", file), "utf8").includes(
              `"sources":[${id}`,
            ),
        ),
      );
    }

    await edge.stop();
    edge = undefined;
    for (const server of servers.splice(0)) await server.stop();
  }
} catch (error) {
  check(
    "the qualification ran to completion",
    false,
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
} finally {
  await browser?.close().catch(() => undefined);
  await edge?.stop().catch(() => undefined);
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  if (!reuse && process.env["STRATA_KEEP_CONSUMER"] !== "1")
    rmSync(tmpRoot, { recursive: true, force: true });
}

finish(TITLE);
