import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Browser } from "playwright";

import { httpGet } from "../../analog/lib/process.ts";

import {
  CANARIES,
  DEV_ROUTE,
  GENERATED_DIR,
  PAGE_FILE,
  SERVER_ONLY_IMPORT,
  devFile,
  logContains,
  openDevPage,
  sameSnapshot,
  sleep,
  snapshotDir,
  strataLogLines,
  until,
} from "./dev-harness.ts";
import type { DevPage, DevServer, Edits } from "./dev-harness.ts";
import { check, section } from "./harness.ts";

/**
 * The scenarios of `pnpm test:server-component-dev`
 * (docs/research/server-component-dev-hmr.md). Each edits the dev fixture's
 * `server-component-dev/*` files while the real Vite dev server runs, observes
 * what the browser and the server do, and puts every file back.
 */

export interface DevContext {
  readonly server: DevServer;
  readonly browser: Browser;
  readonly edits: Edits;
  /** `src/generated/server-components` as it was once the server had started. */
  readonly baseline: Map<string, string>;
}

const RELOAD_LINE = "reloading the document for a new server render";
const FAIL_LINE = "could not be refreshed";
const all = (results: readonly boolean[]): boolean => results.every(Boolean);

const probe = (dev: DevPage, expression: string): Promise<unknown> =>
  dev.page.evaluate(expression).catch(() => undefined);

const hydrated = (dev: DevPage, selector = "dev-island[data-strata-hydrated]"): Promise<boolean> =>
  dev.page
    .waitForSelector(selector, { state: "attached", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

/** `hydrated`, as a check that explains a failure with what the page printed. */
async function hydratedCheck(
  name: string,
  dev: DevPage,
  selector = "dev-island[data-strata-hydrated]",
): Promise<boolean> {
  const ok = await hydrated(dev, selector);

  return check(
    name,
    ok,
    `errors: ${[...dev.log.consoleErrors, ...dev.log.pageErrors].slice(-3).join(" | ")}; failed requests: ${dev.log.entries
      .filter((entry) => (entry.status ?? 0) >= 400)
      .map((entry) => `${entry.status} ${entry.url.slice(-60)}`)
      .slice(-3)
      .join(", ")}`,
  );
}

const text = async (dev: DevPage, selector: string): Promise<string> =>
  (await dev.page
    .locator(selector)
    .first()
    .textContent({ timeout: 5_000 })
    .catch(() => "")) ?? "";

const generated = (name: string): string | undefined => {
  const path = join(GENERATED_DIR, "server-component-dev", name);

  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};

const reloadLines = (output: string): number =>
  strataLogLines(output).filter((line) => line.includes(RELOAD_LINE)).length;

/** The route's SSR HTML, polled until `ready` holds for it (or the timeout passes). */
async function ssrWhen(
  server: DevServer,
  ready: (html: string) => boolean,
  timeoutMs = 20_000,
): Promise<string | undefined> {
  return until(async () => {
    const response = await httpGet(`${server.baseUrl}${DEV_ROUTE}`).catch(() => undefined);

    return response && ready(response.body) ? response.body : undefined;
  }, timeoutMs);
}

const isBaseline = (html: string): boolean =>
  html.includes("Server message A") &&
  html.includes("Server child A") &&
  html.includes("Server note A") &&
  html.includes('data-strata-client="dev-island"') &&
  !html.includes("dev-island-b") &&
  !html.includes("dev-island-c") &&
  !html.includes("data-dev-extra");

/** Resolves once the dev server has printed nothing for `windowMs`. */
async function quiet(server: DevServer, windowMs = 800, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let length = server.mark();
  let since = Date.now();

  while (Date.now() < deadline && Date.now() - since < windowMs) {
    await sleep(100);

    if (server.mark() !== length) {
      length = server.mark();
      since = Date.now();
    }
  }
}

/** Restores every edited file and waits until SSR and the generated surrogates are the baseline again. */
export async function restoreAndSettle(ctx: DevContext): Promise<boolean> {
  ctx.edits.restore();

  const html = await ssrWhen(ctx.server, isBaseline, 30_000);
  const surrogates = await until(
    () => sameSnapshot(snapshotDir(GENERATED_DIR), ctx.baseline).length === 0,
    20_000,
  );

  // The restore's own refreshes and reloads must have drained before the next
  // scenario opens a page, or their reload would land in it.
  await quiet(ctx.server);

  return check(
    "restored: SSR and generated surrogates are the baseline again",
    html !== undefined && surrogates === true,
    html === undefined
      ? "SSR never returned to the baseline"
      : sameSnapshot(snapshotDir(GENERATED_DIR), ctx.baseline).join(", "),
  );
}

interface EditResult {
  readonly replaced: boolean;
  readonly documents: number;
  readonly serverLog: string;
  readonly mark: number;
}

/**
 * Runs `edit` while `dev` shows the route: reports whether the JS realm was
 * replaced (the sentinel is gone) and how many document requests that took.
 */
async function editAndWatch(ctx: DevContext, dev: DevPage, edit: () => void): Promise<EditResult> {
  await dev.markRealm();

  const documents = dev.documentRequests();
  const mark = ctx.server.mark();
  const logMark = dev.log.mark();

  edit();

  const replaced =
    (await until(async () => !(await dev.realmSurvives()), 20_000)) === true &&
    (await until(() => dev.documentRequests() > documents, 20_000)) === true;

  await dev.page.waitForLoadState("load").catch(() => undefined);
  // The negative half of "one reload only": nothing else arrives shortly after.
  await sleep(1_000);

  return {
    replaced,
    documents: dev.documentRequests() - documents,
    serverLog: ctx.server.since(mark),
    mark: logMark,
  };
}

/** A Server Component edit: the document reloads once, SSR is fresh, the island hydrates and works. */
async function checkServerEdit(
  ctx: DevContext,
  label: string,
  edit: () => void,
  expect: string,
  absent: string,
): Promise<boolean> {
  const dev = await openDevPage(ctx.browser, ctx.server);

  try {
    const first = await hydrated(dev);
    const result = await editAndWatch(ctx, dev, edit);
    const html = await ssrWhen(
      ctx.server,
      (body) => body.includes(expect) && !body.includes(absent),
    );
    const hydratedAgain = await hydrated(dev);
    const created = await probe(dev, "globalThis.__STRATA_ISLAND_PROBE__?.created ?? 0");
    const hydratedCount = await probe(
      dev,
      'document.querySelectorAll("dev-island[data-strata-hydrated]").length',
    );

    await dev.page.click("[data-dev-bump]").catch(() => undefined);

    const clicks = await until(
      async () => (await text(dev, "[data-dev-count]")) === "Clicks: 1",
      5_000,
    );

    return all([
      check(`${label}: the page hydrated before the edit`, first),
      check(
        `${label}: the old JS realm was replaced (sentinel absent): a document reload`,
        result.replaced,
      ),
      check(
        `${label}: exactly one document request followed the edit`,
        result.documents === 1,
        String(result.documents),
      ),
      check(
        `${label}: Strata sent exactly one reload`,
        reloadLines(result.serverLog) === 1,
        result.serverLog,
      ),
      check(`${label}: fresh SSR has "${expect}" and not "${absent}"`, html !== undefined),
      check(
        `${label}: the new document shows "${expect}"`,
        (await dev.page.content()).includes(expect),
      ),
      check(
        `${label}: the island hydrated once in the new realm`,
        hydratedAgain && created === 1 && hydratedCount === 1,
        `${String(created)} / ${String(hydratedCount)}`,
      ),
      check(`${label}: one click, one effect`, clicks === true),
      check(
        `${label}: no browser errors`,
        dev.log.consoleErrors.length === 0 && dev.log.pageErrors.length === 0,
        [...dev.log.consoleErrors, ...dev.log.pageErrors].join(" | "),
      ),
    ]);
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }
}

// ---------------------------------------------------------------------------

/** A. The initial dev graph: SSR, hydration, no canary in any browser response. */
export async function checkInitialDev(ctx: DevContext): Promise<boolean> {
  section("A. Initial dev graph: SSR, hydration, interaction, server data stays server-side");

  const dev = await openDevPage(ctx.browser, ctx.server);

  try {
    const ssr = await dev.ssr();
    const ok = await hydrated(dev);
    const created = await probe(dev, "globalThis.__STRATA_ISLAND_PROBE__?.created ?? 0");

    await dev.page.click("[data-dev-bump]");

    const clicked = await until(
      async () => (await text(dev, "[data-dev-count]")) === "Clicks: 1",
      5_000,
    );
    const surrogates = [...snapshotDir(GENERATED_DIR).keys()].filter((name) =>
      name.startsWith("server-component-dev/"),
    );
    const scriptBodies = dev.log.responses.filter((response) => response.type !== "document");

    return all([
      check(
        "HTTP 200 with the Server Component rendered",
        ssr.status === 200 && isBaseline(ssr.body),
      ),
      check(
        "the server-only repository ran on the server (its hash is in the HTML)",
        /data-dev-repository="[0-9a-f]+"/.test(ssr.body),
      ),
      check("the island hydrated once", ok && created === 1, String(created)),
      check("one click, one effect", clicked === true),
      check(
        "the generated surrogates of the dev fixture exist",
        surrogates.includes(join("server-component-dev", "dev-root.server-component.ts")) &&
          surrogates.includes(join("server-component-dev", "dev-boundary.server-component.ts")),
        surrogates.join(", "),
      ),
      check(
        "positive control: the public shared module's canary IS in a browser script (before any assertion)",
        logContains(dev.log, CANARIES.shared).length > 0,
      ),
      check(
        "the server-only repository canary is in no browser response and no HMR frame",
        logContains(dev.log, CANARIES.repository).length === 0 &&
          !ssr.body.includes(CANARIES.repository),
        logContains(dev.log, CANARIES.repository).join(", "),
      ),
      check(
        "no Server Component implementation module was requested by the browser",
        scriptBodies.every(
          (response) =>
            !/\/src\/app\/server-component-dev\/(dev-root|dev-child|dev-note|dev-repository)/.test(
              response.url,
            ),
        ),
        scriptBodies.map((response) => response.url).join(", "),
      ),
      check(
        "no browser errors on a clean start",
        dev.log.consoleErrors.length === 0 && dev.log.pageErrors.length === 0,
        [...dev.log.consoleErrors, ...dev.log.pageErrors].join(" | "),
      ),
    ]);
  } finally {
    await dev.close();
  }
}

/** B, C, D. Server-owned edits: the Server Component, an ordinary child, a templateUrl grandchild. */
export async function checkServerOwnedEdits(ctx: DevContext): Promise<boolean> {
  section("B. Server Component source edit → document reload");

  const results: boolean[] = [];

  results.push(
    await checkServerEdit(
      ctx,
      "B",
      () =>
        ctx.edits.replace(
          devFile("dev-root.server-component.ts"),
          "Server message A",
          "Server message B",
        ),
      "Server message B",
      "Server message A",
    ),
  );

  section("C. Ordinary server-owned child edit → document reload (root file untouched)");
  results.push(
    await checkServerEdit(
      ctx,
      "C",
      () =>
        ctx.edits.replace(devFile("dev-child.component.ts"), "Server child A", "Server child B"),
      "Server child B",
      "Server child A",
    ),
  );

  section("D. templateUrl grandchild (.html) edit → document reload");
  results.push(
    await checkServerEdit(
      ctx,
      "D",
      () => ctx.edits.replace(devFile("dev-note.component.html"), "Server note A", "Server note B"),
      "Server note B",
      "Server note A",
    ),
  );

  return all(results);
}

const ISLAND_BOUNDARY = (
  island: "B" | "C",
): string => `import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { DevIsland${island}Component } from "./dev-island-${island.toLowerCase()}.component";

@ServerComponent()
@Component({
  selector: "dev-boundary",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DevIsland${island}Component, StrataClientBoundary],
  template: \`<aside data-dev-boundary>Boundary host</aside>
    <dev-island-${island.toLowerCase()} [strataClient]="{}" />\`,
})
export class DevBoundaryServerComponent {}
`;

/** E, F, boundary type change, and the repeated-edit cycle (no stale islands). */
export async function checkBoundaryLifecycle(ctx: DevContext): Promise<boolean> {
  section("E. Boundary added → surrogate regenerated, reload, island hydrates and works");

  const dev = await openDevPage(ctx.browser, ctx.server);
  const boundary = devFile("dev-boundary.server-component.ts");
  const results: boolean[] = [];

  try {
    results.push(check("start: the page hydrated, one island", await hydrated(dev)));
    results.push(
      check(
        "start: the dev-boundary surrogate imports no client reference",
        !(generated("dev-boundary.server-component.ts") ?? "").includes("DevIslandB"),
      ),
    );

    // E: 0 → 1 boundary.
    let result = await editAndWatch(ctx, dev, () =>
      ctx.edits.write(boundary, ISLAND_BOUNDARY("B")),
    );

    results.push(
      check(
        "E: document reloaded once",
        result.replaced && result.documents === 1,
        String(result.documents),
      ),
      check(
        "E: the surrogate was regenerated and imports DevIslandBComponent",
        (generated("dev-boundary.server-component.ts") ?? "").includes("DevIslandBComponent"),
      ),
      check(
        "E: SSR includes the new boundary",
        (await ssrWhen(ctx.server, (html) =>
          html.includes('data-strata-client="dev-island-b"'),
        )) !== undefined,
      ),
      check(
        "E: the new island hydrated",
        await hydrated(dev, "dev-island-b[data-strata-hydrated]"),
      ),
    );
    await dev.page.click("[data-dev-island-b]");
    results.push(
      check(
        "E: its interaction works (one click, one effect)",
        (await until(
          async () => (await text(dev, "[data-dev-island-b-count]")) === "B clicks: 1",
          5_000,
        )) === true,
      ),
    );

    // Boundary type change: ClientB → ClientC.
    section("Boundary type changed (ClientB → ClientC)");
    result = await editAndWatch(ctx, dev, () => ctx.edits.write(boundary, ISLAND_BOUNDARY("C")));

    const surrogate = generated("dev-boundary.server-component.ts") ?? "";

    results.push(
      check(
        "document reloaded once",
        result.replaced && result.documents === 1,
        String(result.documents),
      ),
      check(
        "the surrogate imports ClientC and no longer ClientB",
        surrogate.includes("DevIslandCComponent") && !surrogate.includes("DevIslandBComponent"),
      ),
      check("ClientC hydrated", await hydrated(dev, "dev-island-c[data-strata-hydrated]")),
      check(
        "no ClientB island remains in the document",
        (await dev.page.locator("dev-island-b").count()) === 0,
      ),
    );

    // F: 1 → 0 boundaries (the original source).
    section("F. Boundary removed → no stale client reference, no stale island");
    result = await editAndWatch(ctx, dev, () =>
      ctx.edits.write(boundary, ctx.edits.original(boundary)),
    );

    const afterRemoval = generated("dev-boundary.server-component.ts") ?? "";
    const islands = await probe(dev, 'document.querySelectorAll("[data-strata-client]").length');

    results.push(
      check(
        "document reloaded once",
        result.replaced && result.documents === 1,
        String(result.documents),
      ),
      check(
        "the surrogate holds no client reference any more",
        !afterRemoval.includes("DevIslandB") && !afterRemoval.includes("DevIslandC"),
      ),
      check("only dev-root's island remains in the document", islands === 1, String(islands)),
    );
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }

  return all(results);
}

// ---------------------------------------------------------------------------

/** G. A client island edit: Strata must not force a document reload. */
export async function checkClientEdit(
  ctx: DevContext,
  mode: "stock" | "liveReload",
): Promise<boolean> {
  section(
    mode === "stock"
      ? "G. Client island edit (Analog default, liveReload off): Strata forces no reload"
      : "G2. Client island edit (Analog liveReload on): Angular component HMR, same realm, no document",
  );

  const dev = await openDevPage(ctx.browser, ctx.server);

  try {
    const ok = await hydrated(dev);

    await dev.page.click("[data-dev-bump]");
    await until(async () => (await text(dev, "[data-dev-count]")) === "Clicks: 1", 5_000);
    await dev.markRealm();

    const documents = dev.documentRequests();
    const mark = ctx.server.mark();
    const before = dev.log.entries.length;

    ctx.edits.replace(devFile("dev-island.component.ts"), "Client label A", "Client label B");

    const updated = await until(
      async () => (await text(dev, "[data-dev-bump]")).includes("Client label B"),
      20_000,
    );

    await sleep(1_000);

    const log = ctx.server.since(mark);
    const survives = await dev.realmSurvives();
    const requests = dev.log.entries
      .slice(before)
      .map((entry) => `${entry.type} ${entry.url.replace(ctx.server.baseUrl, "")}`);

    console.log(
      `  record: realm retained=${String(survives)}, document requests=${dev.documentRequests() - documents}, requests after the edit: ${requests.join("; ") || "(none)"}`,
    );
    console.log(
      `  record: vite log: ${log
        .split("\n")
        .filter((line) => /hmr update|page reload/.test(line))
        .map((line) => line.replace(/^.*\[vite\] /, ""))
        .join(" | ")}`,
    );

    return all([
      check("start: the page hydrated", ok),
      check("the new client UI is visible", updated === true),
      check(
        "Strata did not force a reload (no Strata reload line in the Vite log)",
        reloadLines(log) === 0,
        log,
      ),
      check(
        "the edit was classified as client-owned: the Strata refresh found the graph unchanged",
        /graph refreshed/.test(log),
        log,
      ),
      ...(mode === "liveReload"
        ? [
            check("same JS realm (the sentinel survived)", survives),
            check(
              "no document request",
              dev.documentRequests() === documents,
              String(dev.documentRequests() - documents),
            ),
            check(
              "component state survived the update (Clicks: 1)",
              (await text(dev, "[data-dev-count]")) === "Clicks: 1",
            ),
          ]
        : []),
    ]);
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }
}

/**
 * `fetch` from inside the page, returning once the page's request log has the
 * response too, so a log position taken afterwards cannot include it.
 */
async function fetchIn(dev: DevPage, url: string): Promise<{ status: number; body: string }> {
  const logged = dev.log.responses.length;
  const result: { status: number; body: string } = await dev.page.evaluate(
    `fetch(${JSON.stringify(url)}).then(async (r) => ({ status: r.status, body: await r.text() }))`,
  );

  await until(
    () => dev.log.responses.slice(logged).some((response) => response.url === url),
    5_000,
    20,
  );

  return result;
}

/** After a failed graph the router may have left the route; recovery means getting back to it. */
async function returnToRoute(dev: DevPage, server: DevServer): Promise<void> {
  // The router may still be bouncing off the failed route when recovery starts:
  // retry until a navigation to the route is not interrupted by another.
  for (let attempt = 0; attempt < 6; attempt++) {
    await dev.page.waitForLoadState("load").catch(() => undefined);

    if (new URL(dev.page.url()).pathname === DEV_ROUTE) return;

    await dev.page
      .goto(`${server.baseUrl}${DEV_ROUTE}`, { waitUntil: "load" })
      .catch(() => undefined);
  }
}

const moduleUrl = (ctx: DevContext, name: string, query = ""): string =>
  `${ctx.server.baseUrl}/src/app/server-component-dev/${name}${query}`;

/** H. A module becomes server-only while Vite runs. */
export async function checkLiveServerOnly(ctx: DevContext): Promise<boolean> {
  section("H. A server-only assertion added while Vite runs (live firewall)");

  const dev = await openDevPage(ctx.browser, ctx.server);
  const shared = devFile("dev-shared.ts");
  const url = moduleUrl(ctx, "dev-shared.ts");
  const results: boolean[] = [];

  try {
    results.push(check("start: the page hydrated", await hydrated(dev)));

    // Before: the module is public and the browser receives it.
    const before = await fetchIn(dev, url);

    results.push(
      check(
        "BEFORE the assertion (positive control): the browser can load the module and gets the canary",
        before.status === 200 && before.body.includes(CANARIES.shared),
        String(before.status),
      ),
    );

    const since = dev.log.mark();
    const result = await editAndWatch(ctx, dev, () =>
      ctx.edits.write(shared, `${SERVER_ONLY_IMPORT}\n${ctx.edits.original(shared)}`),
    );

    results.push(
      check(
        "AFTER: the old realm was terminated by a document reload",
        result.replaced && result.documents >= 1,
        String(result.documents),
      ),
      check(
        "the Strata diagnostic names the module and the reason, in the server log",
        /Server-only module entered the browser graph: .*dev-shared\.ts/.test(result.serverLog) &&
          result.serverLog.includes("declares `import"),
        result.serverLog,
      ),
    );

    // The new realm cannot get it: its own module request fails closed.
    const failed = await until(
      () =>
        dev.log.entries.some(
          (entry) => entry.url.startsWith(url) && entry.status !== undefined && entry.status >= 400,
        ),
      20_000,
    );
    const after = await fetchIn(dev, url);
    const fresh = await fetchIn(dev, `${url}?raw`);

    results.push(
      check("the new realm's request for the module failed (HTTP >= 400)", failed === true),
      check(
        "a direct request is rejected too, and its body holds no canary",
        after.status >= 400 && !after.body.includes(CANARIES.shared),
        String(after.status),
      ),
      check(
        "?raw is rejected as well",
        fresh.status >= 400 && !fresh.body.includes(CANARIES.shared),
        String(fresh.status),
      ),
      check(
        "no response or HMR frame since the edit contains the canary",
        logContains(dev.log, CANARIES.shared, since).length === 0,
        logContains(dev.log, CANARIES.shared, since).join(", "),
      ),
      check(
        "the new document did not hydrate the island (the graph failed closed)",
        (await dev.page.locator("dev-island[data-strata-hydrated]").count()) === 0,
      ),
    );

    // Removing the assertion recovers without restarting Vite.
    section("H. (continued) Assertion removed → the graph recovers, no restart");
    await dev.markRealm();
    ctx.edits.restore();

    const recovered = await until(async () => !(await dev.realmSurvives()), 20_000);

    results.push(
      check("the document reloaded after the fix", recovered === true),
      await (async () => {
        await returnToRoute(dev, ctx.server);

        return hydratedCheck("the island hydrated again (back on the route)", dev);
      })(),
      check("the module is public again (HTTP 200)", (await fetchIn(dev, url)).status === 200),
      check("the dev server process never exited", !ctx.server.process.hasExited()),
    );
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }

  return all(results);
}

/** H2. Dynamic imports and query imports are firewalled in dev too. */
export async function checkDynamicAndQuery(ctx: DevContext): Promise<boolean> {
  section("H2. Dynamic import and ?raw / ?url of a module that becomes server-only");

  const dev = await openDevPage(ctx.browser, ctx.server);
  const lazy = devFile("dev-lazy.ts");
  const results: boolean[] = [];

  try {
    results.push(check("start: the page hydrated", await hydrated(dev)));
    await dev.page.click("[data-dev-lazy]");
    results.push(
      check(
        "BEFORE (positive control): the island's dynamic import() works",
        (await until(
          async () => (await text(dev, "[data-dev-lazy-result]")).startsWith("lazy:"),
          10_000,
        )) === true,
      ),
    );

    const raw = await fetchIn(dev, moduleUrl(ctx, "dev-lazy.ts", "?raw"));

    results.push(
      check(
        "BEFORE (positive control): ?raw would ship the module's source and canary",
        raw.status === 200 && raw.body.includes(CANARIES.lazy),
        String(raw.status),
      ),
    );

    const since = dev.log.mark();
    const result = await editAndWatch(ctx, dev, () =>
      ctx.edits.write(lazy, `${SERVER_ONLY_IMPORT}\n${ctx.edits.original(lazy)}`),
    );

    results.push(
      check("AFTER: the old realm was terminated", result.replaced),
      check("the island hydrated in the new realm", await hydrated(dev)),
    );
    await dev.page.click("[data-dev-lazy]");
    results.push(
      check(
        "the browser-owned dynamic import() now fails",
        (await until(
          async () => (await text(dev, "[data-dev-lazy-result]")) === "lazy failed",
          10_000,
        )) === true,
      ),
    );

    for (const query of ["", "?raw", "?url"]) {
      const response = await fetchIn(dev, moduleUrl(ctx, "dev-lazy.ts", query));

      results.push(
        check(
          `${query || "a plain module request"} is rejected with no canary`,
          response.status >= 400 && !response.body.includes(CANARIES.lazy),
          String(response.status),
        ),
      );
    }

    results.push(
      check(
        "no response or HMR frame since the edit contains the canary",
        logContains(dev.log, CANARIES.lazy, since).length === 0,
        logContains(dev.log, CANARIES.lazy, since).join(", "),
      ),
    );
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }

  return all(results);
}

/** I. A barrel starts re-exporting a server-only module. */
export async function checkLiveBarrel(ctx: DevContext): Promise<boolean> {
  section("I. A barrel starts re-exporting a server-only module (re-export taint, live)");

  const dev = await openDevPage(ctx.browser, ctx.server);
  const barrel = devFile("dev-barrel.ts");
  const url = moduleUrl(ctx, "dev-barrel.ts");
  const results: boolean[] = [];

  try {
    results.push(check("start: the page hydrated", await hydrated(dev)));
    results.push(
      check(
        "BEFORE: the barrel is browser-safe (HTTP 200)",
        (await fetchIn(dev, url)).status === 200,
      ),
    );

    const since = dev.log.mark();
    const result = await editAndWatch(ctx, dev, () =>
      ctx.edits.write(
        barrel,
        `${ctx.edits.original(barrel)}export { readDevRepository } from "./dev-repository";\n`,
      ),
    );
    const response = await fetchIn(dev, url);

    results.push(
      check("AFTER: the old realm was terminated", result.replaced),
      check(
        "the barrel is rejected at once (fail closed) and its body holds no canary",
        response.status >= 400 && !response.body.includes(CANARIES.repository),
        String(response.status),
      ),
      check(
        "the diagnostic names the re-export chain",
        /re-exports a server-only module: .*dev-barrel\.ts.*dev-repository\.ts/.test(
          result.serverLog,
        ),
        result.serverLog,
      ),
      check(
        "the new document did not hydrate the island (the graph failed closed)",
        (await dev.page.locator("dev-island[data-strata-hydrated]").count()) === 0,
      ),
      check(
        "the repository canary is in no response or HMR frame since the edit",
        logContains(dev.log, CANARIES.repository, since).length === 0,
      ),
    );

    // Fix: stop re-exporting it.
    await dev.markRealm();
    ctx.edits.restore();

    const reloaded = await until(async () => !(await dev.realmSurvives()), 20_000);

    await returnToRoute(dev, ctx.server);
    results.push(
      check(
        "removing the re-export reloads the document (recovery, no restart)",
        reloaded === true,
      ),
      await hydratedCheck("the island hydrates again (back on the route)", dev),
    );
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }

  return all(results);
}

/** J, K, composition: an invalid server-owned edit gives a diagnostic and fails closed; the fix recovers. */
export async function checkInvalidEdit(
  ctx: DevContext,
  label: string,
  apply: () => void,
  diagnostic: RegExp,
): Promise<boolean> {
  section(label);

  const dev = await openDevPage(ctx.browser, ctx.server);
  const results: boolean[] = [];

  try {
    results.push(check("start: the page hydrated", await hydrated(dev)));
    await dev.markRealm();

    const mark = ctx.server.mark();

    apply();

    const reported = await until(() => ctx.server.since(mark).includes(FAIL_LINE), 20_000);
    const log = ctx.server.since(mark);
    const client = await fetchIn(dev, moduleUrl(ctx, "dev-island.component.ts"));

    results.push(
      check("the edit produced a Strata diagnostic in the server log", reported === true, log),
      check(
        "the diagnostic is the analyzer's own (file, component, reason, fix)",
        diagnostic.test(log),
        log,
      ),
      check(
        "the client graph is closed: even an unrelated app module is refused",
        client.status >= 400 && client.body.includes("could not be refreshed"),
        String(client.status),
      ),
      check(
        "the browser shows Vite's error overlay",
        (await until(
          async () => (await dev.page.locator("vite-error-overlay").count()) > 0,
          10_000,
        )) === true,
      ),
      check("the dev server is still running", !ctx.server.process.hasExited()),
    );

    // The fix: put the file back.
    const fixed = ctx.server.mark();

    await dev.markRealm();
    ctx.edits.restore();

    const reloaded = await until(async () => !(await dev.realmSurvives()), 20_000);

    results.push(
      check("after the fix the document reloads (recovery, no restart)", reloaded === true),
      await (async () => {
        await returnToRoute(dev, ctx.server);

        return hydratedCheck("the island hydrates again (back on the route)", dev);
      })(),
      check(
        "the client graph is open again",
        (await fetchIn(dev, moduleUrl(ctx, "dev-island.component.ts"))).status === 200,
      ),
      check(
        "no failure line after the fix",
        !ctx.server.since(fixed).includes(FAIL_LINE),
        ctx.server.since(fixed),
      ),
    );
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }

  return all(results);
}

const EXTRA_SERVER_COMPONENT = `import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

@ServerComponent()
@Component({
  selector: "dev-extra",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: \`<p data-dev-extra>Extra server component</p>\`,
})
export class DevExtraServerComponent {}
`;

/** L. A Server Component module is created, wired into the page, then removed. */
export async function checkCreateAndDelete(ctx: DevContext): Promise<boolean> {
  section("L. A Server Component created while Vite runs, wired into the page, then deleted");

  const extra = devFile("dev-extra.server-component.ts");
  const results: boolean[] = [];
  const dev = await openDevPage(ctx.browser, ctx.server);

  try {
    results.push(check("start: the page hydrated", await hydrated(dev)));
    results.push(
      check(
        "start: no dev-extra surrogate",
        generated("dev-extra.server-component.ts") === undefined,
      ),
    );

    ctx.edits.write(extra, EXTRA_SERVER_COMPONENT);

    results.push(
      check(
        "the new module's surrogate is generated without a restart",
        (await until(() => generated("dev-extra.server-component.ts") !== undefined, 20_000)) !==
          undefined,
      ),
    );

    // Wiring is a second write: the page imports it and renders it.
    ctx.edits.write(
      PAGE_FILE,
      ctx.edits
        .read(PAGE_FILE)
        .replace(
          "import { DevRootServerComponent }",
          'import { DevExtraServerComponent } from "../server-component-dev/dev-extra.server-component";\nimport { DevRootServerComponent }',
        )
        .replace(
          "imports: [DevBoundaryServerComponent,",
          "imports: [DevBoundaryServerComponent, DevExtraServerComponent,",
        )
        .replace("<dev-boundary />", "<dev-boundary />\n    <dev-extra />"),
    );

    const html = await ssrWhen(ctx.server, (body) => body.includes("data-dev-extra"));
    const surrogate = generated("dev-extra.server-component.ts") ?? "";

    results.push(
      check("SSR renders the new Server Component", html !== undefined),
      check(
        "its surrogate is an empty-template component with the same selector",
        surrogate.includes('selector: "dev-extra"') && surrogate.includes('template: ""'),
      ),
      check(
        "the browser document shows it",
        (await until(
          async () => (await dev.page.locator("[data-dev-extra]").count()) > 0,
          20_000,
        )) === true ||
          (await dev.page.reload().then(() => dev.page.locator("[data-dev-extra]").count())) > 0,
      ),
      check("the page still hydrates its island", await hydrated(dev)),
    );

    // Unwire first, then delete the module.
    ctx.edits.write(PAGE_FILE, ctx.edits.original(PAGE_FILE));
    results.push(
      check(
        "the unwired page no longer renders it",
        (await ssrWhen(ctx.server, (body) => !body.includes("data-dev-extra"))) !== undefined,
      ),
    );

    const mark = ctx.server.mark();

    ctx.edits.delete(extra);
    results.push(
      check(
        "deleting the module removes its stale surrogate",
        (await until(() => generated("dev-extra.server-component.ts") === undefined, 20_000)) ===
          true,
      ),
      check(
        "no graph failure was reported",
        !ctx.server.since(mark).includes(FAIL_LINE),
        ctx.server.since(mark),
      ),
      check("the page still renders and hydrates", isBaseline((await dev.ssr()).body)),
    );
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }

  return all(results);
}

/** M. Several edit/reload cycles leave only the current islands, each with one effect. */
export async function checkRepeatedEdits(ctx: DevContext): Promise<boolean> {
  section("M. Repeated server edit / boundary add / boundary remove cycles: no stale islands");

  const dev = await openDevPage(ctx.browser, ctx.server);
  const root = devFile("dev-root.server-component.ts");
  const boundary = devFile("dev-boundary.server-component.ts");
  const results: boolean[] = [];

  try {
    results.push(check("start: the page hydrated", await hydrated(dev)));

    const steps: [string, () => void][] = [
      ["server edit A → B", () => ctx.edits.replace(root, "Server message A", "Server message B")],
      ["server edit B → C", () => ctx.edits.replace(root, "Server message B", "Server message C")],
      ["boundary added", () => ctx.edits.write(boundary, ISLAND_BOUNDARY("B"))],
      ["boundary removed", () => ctx.edits.write(boundary, ctx.edits.original(boundary))],
    ];

    for (const [name, apply] of steps) {
      const result = await editAndWatch(ctx, dev, apply);

      results.push(
        check(
          `${name}: one reload`,
          result.replaced && result.documents === 1 && reloadLines(result.serverLog) === 1,
          `${result.documents} documents, ${reloadLines(result.serverLog)} Strata reloads`,
        ),
      );
      await hydrated(dev);
    }

    const islands = await probe(dev, 'document.querySelectorAll("[data-strata-client]").length');
    const hydratedIslands = await probe(
      dev,
      'document.querySelectorAll("[data-strata-hydrated]").length',
    );
    const created = await probe(dev, "globalThis.__STRATA_ISLAND_PROBE__?.created ?? 0");
    const html = (await dev.ssr()).body;

    await dev.page.click("[data-dev-bump]");
    results.push(
      check(
        "the current document holds exactly the current island",
        islands === 1 && hydratedIslands === 1,
        `${String(islands)} / ${String(hydratedIslands)}`,
      ),
      check("one ComponentRef was created in this realm", created === 1, String(created)),
      check(
        "SSR shows the last message and no island left over from a removed boundary",
        html.includes("Server message C") && !html.includes("dev-island-b"),
      ),
      check(
        "one click, one effect (no duplicate listeners)",
        (await until(async () => (await text(dev, "[data-dev-count]")) === "Clicks: 1", 5_000)) ===
          true,
      ),
      check(
        "no browser errors across the cycles",
        dev.log.consoleErrors.length === 0 && dev.log.pageErrors.length === 0,
        [...dev.log.consoleErrors, ...dev.log.pageErrors].join(" | "),
      ),
    );
  } finally {
    await dev.close();
    await restoreAndSettle(ctx);
  }

  return all(results);
}

/** Refresh timings the server printed (`graph refreshed in N ms`), in milliseconds. */
export function refreshTimings(output: string): number[] {
  return [...output.matchAll(/graph refreshed in (\d+) ms/g)].map((match) => Number(match[1]));
}
