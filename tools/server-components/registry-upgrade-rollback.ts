import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { observeCorrelation } from "../analog/lib/correlation.ts";
import { httpGet } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";
import { observeStreaming } from "../analog/lib/streaming.ts";
import { TUPLE_PACKAGES, tupleProblems } from "../release/lib/registry-tuple.ts";
import type { LockEntry, TuplePackage } from "../release/lib/registry-tuple.ts";

import { MAX_REQUESTS_PER_URL, runConcurrencyMatrix } from "./lib/concurrency-matrix.ts";
import {
  AliasOrigin,
  DEFAULT_UPGRADE_BRANCH,
  UPGRADE_DEPLOY_PROJECT,
  branchAliasUrl,
  deployTargetProblems,
  servesBuild,
  staleAssets,
} from "./lib/deployed-upgrade.ts";
import { Edge, entryScript, filesContaining, isolated } from "./lib/deployment-skew.ts";
import type { Plan, Release, Rewrite } from "./lib/deployment-skew.ts";
import { tscDeclarations } from "./lib/full-stack-declarations.ts";
import {
  FULL_STACK_SERVER_SOURCES,
  PRIVATE_CANARIES,
  SERVER_ONLY_MARKERS,
} from "./lib/full-stack-fixture.ts";
import { Abort, all, sanitize } from "./lib/full-stack-install.ts";
import {
  NotAvailable,
  installRegistryConsumer,
  lookupTuple,
} from "./lib/full-stack-registry-install.ts";
import type { RegistryInstall } from "./lib/full-stack-registry-install.ts";
import { surfaceSuite } from "./lib/full-stack-remote.ts";
import { routingBrowserSuite, routingSuite } from "./lib/full-stack-routing.ts";
import { httpSuite, islandSuite, navigationSuite } from "./lib/full-stack-verify.ts";
import { check, failureCount, finish, section } from "./lib/harness.ts";
import { startNodeServer, startWrangler, until } from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";
import { deployToPages } from "./lib/pages-deploy.ts";
import {
  INIT_SCRIPT,
  OBSERVE,
  buildInstalledRelease,
  fileDigest,
  isValidBuildId,
  pairEnvName,
  selectedBuildIds,
  selectedPair,
  treeDigest,
} from "./lib/upgrade-rollback.ts";
import type { Observed, Side } from "./lib/upgrade-rollback.ts";
import { COMPATIBILITY_DATE } from "./lib/wrangler.ts";

/**
 * `pnpm test:full-stack-registry-upgrade-rollback`: can a real external Analog consumer move
 * between two PUBLISHED Strata package combinations and back? (docs/research/full-stack-registry-upgrade-rollback.md)
 *
 *   npm registry ─► consumer A (exact versions) ─► build A ─┐
 *   npm registry ─► consumer B (exact versions) ─► build B ─┤ one "edge" per runtime serves
 *                                                           │ A's or B's document with A's or B's
 *                                                           ▼ scripts; Chromium observes
 *
 * Runtimes: Nitro Node production and LOCAL workerd (`wrangler pages dev`; NOT a deployed Pages
 * project). The release A/B exact versions come from `STRATA_UPGRADE_{A,B}_{CORE,ANALOG,SERVER_COMPONENTS}_VERSION`.
 * Nothing is published or substituted: an unpublished version is NOT AVAILABLE (exit 3).
 *
 * DEPLOYMENT-AWARE phase (with the cloudflare runtime): A, then B, then A's RETAINED artifact are
 * "deployed" in turn to one stable origin, and stale clients get the previous deployment's real
 * assets from its immutable URL. By default this is a LOCAL REHEARSAL (wrangler + a local alias).
 * `STRATA_UPGRADE_DEPLOY=1` deploys for real, only to the isolated `strata-fullstack-qualification`
 * Pages project on a preview branch (`STRATA_UPGRADE_PAGES_BRANCH`, default m5-upgrade-rollback),
 * only after the rehearsal passed, and only from the manual workflow. Credentials are removed from
 * every other command and redacted from output. Without them the result is DEPLOYED NOT RUN.
 */

const TITLE = "published-registry upgrade/rollback qualification";
const runtimes = (process.env["STRATA_UPGRADE_RUNTIMES"] ?? "node,cloudflare").split(",");
const SIDES = ["a", "b"] as const;
const PAGE = "/products/42";
const TUPLE_LIST: readonly TuplePackage[] = TUPLE_PACKAGES;

const DEPLOY = process.env["STRATA_UPGRADE_DEPLOY"] === "1";
const REQUIRE_DEPLOYED = process.env["STRATA_UPGRADE_REQUIRE_DEPLOYED"] === "1";
const DEPLOY_TARGET = {
  project: process.env["STRATA_UPGRADE_PAGES_PROJECT"] ?? UPGRADE_DEPLOY_PROJECT,
  branch: process.env["STRATA_UPGRADE_PAGES_BRANCH"] ?? DEFAULT_UPGRADE_BRANCH,
};
const REHEARSE = process.env["STRATA_UPGRADE_DEPLOYED_PHASE"] !== "0";

if (DEPLOY) {
  const problems = deployTargetProblems(DEPLOY_TARGET);

  if (problems.length > 0 || !runtimes.includes("cloudflare")) {
    console.error(
      `${TITLE}: refusing deployment: ${[...problems, ...(runtimes.includes("cloudflare") ? [] : ["the cloudflare runtime is required"])].join("; ")}`,
    );
    process.exit(2);
  }
}

/** Credentials exist only for `wrangler pages deploy`; every other command runs without them. */
const credentials = {
  token: process.env["CLOUDFLARE_API_TOKEN"],
  account: process.env["CLOUDFLARE_ACCOUNT_ID"],
};
const secrets = [credentials.token, credentials.account, process.env["CLOUDFLARE_API_KEY"]].filter(
  (value): value is string => !!value && value.length > 3,
);
const redact = (text: string): string =>
  secrets.reduce((out, secret) => out.split(secret).join("***"), sanitize(text));

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-upgrade-rollback-"));
const env = isolated(tmpRoot);

for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"])
  delete env[name];
const servers: RunningServer[] = [];
const timings: string[] = [];
let browser: Browser | undefined;
let edge: Edge | undefined;
let notAvailable: NotAvailable | undefined;

const time = <T>(label: string, work: () => T): T => {
  const started = performance.now();

  try {
    return work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};

/** Machine-readable evidence for the report (`STRATA_UPGRADE_EVIDENCE=<path>` writes it). */
const evidence: Record<string, unknown> = { runtimes: {} };
const perRuntime = (runtime: string): Record<string, unknown> => {
  const bag = evidence["runtimes"] as Record<string, Record<string, unknown>>;

  return (bag[runtime] ??= {});
};

// ---------------------------------------------------------------------------
// Browser

interface Visit {
  readonly page: Page;
  readonly console: string[];
  readonly pageErrors: string[];
  readonly documents: string[];
  readonly api: string[];
  close(): Promise<void>;
}

async function visit(extraInit = ""): Promise<Visit> {
  const context: BrowserContext = await browser!.newContext();
  const page = await context.newPage();
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  const documents: string[] = [];
  const api: string[] = [];

  await context.addInitScript(INIT_SCRIPT + extraInit);
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      consoleLines.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.request().resourceType() === "document") documents.push(response.url());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url());
  });

  return { page, console: consoleLines, pageErrors, documents, api, close: () => context.close() };
}

const observe = (page: Page): Promise<Observed> => page.evaluate(OBSERVE);

/** Every Server Component host accounted for: hydrated, or reported by the ErrorHandler. */
async function settled(page: Page, hosts: number): Promise<Observed> {
  const seen = await until(
    async () => {
      const now = await observe(page).catch(() => undefined);

      return now && now.hosts >= hosts && now.hydratedHosts + now.errors.length >= hosts
        ? now
        : undefined;
    },
    45_000,
    50,
  );

  if (!seen) throw new Error(`timed out waiting for ${hosts} host(s) to hydrate or be refused`);

  return seen;
}

const statusOf = (page: Page, host: number) =>
  page.locator("product-details").nth(host).locator("product-availability output");

/** Click "Refresh availability" on a host: healthy iff exactly the controller answer reaches the DOM. */
async function interactive(v: Visit, host = 0): Promise<boolean> {
  const before = v.api.length;

  await v.page
    .locator("product-details")
    .nth(host)
    .locator("product-availability button[data-product-id]")
    .click();

  const updated = await until(
    async () => (await statusOf(v.page, host).innerText()) === "Availability: available",
    15_000,
    50,
  );

  return Boolean(updated) && v.api.length - before === 1;
}

/** A refused host stays server-rendered: the click changes nothing and sends no API request. */
async function inert(v: Visit, host = 0): Promise<boolean> {
  const before = v.api.length;

  await v.page
    .locator("product-details")
    .nth(host)
    .locator("product-availability button[data-product-id]")
    .click();
  await v.page.waitForLoadState("networkidle");

  return (
    (await statusOf(v.page, host).innerText()) === "Availability: not checked" &&
    v.api.length === before
  );
}

/** Console and page errors that are NOT the application's own classified ErrorHandler line. */
const unexpected = (v: Visit, seen: Observed): string[] => [
  ...v.pageErrors.map((e) => `pageerror: ${e}`),
  ...v.console.filter((line) => !line.startsWith("ERROR ")),
  ...seen.unhandled.map((e) => `unhandledrejection: ${e}`),
];

const leaks = (...texts: string[]): string[] =>
  PRIVATE_CANARIES.filter((canary) => texts.some((text) => text.includes(canary)));

/** A refusal is a mismatch only when it is classified and names both builds. */
const mismatchNaming = (
  error: Observed["errors"][number] | undefined,
  browserId: string,
  serverId: string,
): boolean =>
  error?.name === "StrataBuildMismatchError" &&
  error.category === "build-mismatch" &&
  error.message.includes(`"${browserId}"`) &&
  error.message.includes(`"${serverId}"`);

/** The cloudflare-preset artifacts of A and B, retained for the deployment-aware phase. */
let cloudflareRelease:
  | { dirs: Record<Side, string>; digests: Record<Side, { tree: string; entry: string }> }
  | undefined;

// ---------------------------------------------------------------------------
// Deployment-aware upgrade and rollback (local rehearsal or the isolated Pages project)

interface DeployTarget {
  /** LOCAL REHEARSAL or DEPLOYED: what the evidence may be called. */
  readonly kind: "LOCAL REHEARSAL" | "DEPLOYED";
  readonly alias: string;
  deploy(side: Side): Promise<{ immutable: string; record: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Bounded readiness: the alias must serve `buildId` (SSR stamps and the controller) N times in a row. */
async function awaitBuild(
  base: string,
  buildId: string,
  deployed: boolean,
): Promise<{ ready: boolean; attempts: number; notReady: string[] }> {
  const attempts = deployed ? 60 : 40;
  const interval = deployed ? 3_000 : 100;
  const consecutive = deployed ? 3 : 1;
  const notReady: string[] = [];
  let streak = 0;
  let made = 0;

  for (let attempt = 1; attempt <= attempts && streak < consecutive; attempt++) {
    made = attempt;
    const page = await httpGet(`${base}${PAGE}`).catch((error: unknown) => ({
      status: 0,
      body: String(error),
    }));
    const api = await httpGet(`${base}/api/products/42`).catch(() => ({ status: 0, body: "" }));
    const ok = page.status === 200 && servesBuild(page.body, buildId) && api.status === 200;

    if (!ok) notReady.push(`#${attempt}: page ${page.status}, api ${api.status}`);
    streak = ok ? streak + 1 : 0;
    if (streak < consecutive) await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return { ready: streak >= consecutive, attempts: made, notReady };
}

async function rehearsalTarget(dirs: Record<Side, string>): Promise<DeployTarget> {
  const alias = new AliasOrigin();
  const immutable = {} as Record<Side, RunningServer>;

  await alias.start();

  return {
    kind: "LOCAL REHEARSAL",
    alias: alias.baseUrl,
    async deploy(side) {
      immutable[side] ??= await startWrangler(dirs[side], env, PAGE);
      alias.point(immutable[side].baseUrl);

      return {
        immutable: immutable[side].baseUrl,
        record: { side, immutable: immutable[side].baseUrl, via: "local wrangler + AliasOrigin" },
      };
    },
    async close() {
      await alias.stop();
      for (const server of Object.values(immutable)) await server.stop().catch(() => undefined);
    },
  };
}

function pagesTarget(dirs: Record<Side, string>): DeployTarget {
  const { project, branch } = DEPLOY_TARGET;

  return {
    kind: "DEPLOYED",
    alias: branchAliasUrl(project, branch),
    deploy(side) {
      writeFileSync(
        join(dirs[side], "wrangler.jsonc"),
        `${JSON.stringify({ name: project, pages_build_output_dir: "./dist/analog/public", compatibility_date: COMPATIBILITY_DATE }, null, 2)}\n`,
      );

      const deployment = deployToPages({
        consumerDir: dirs[side],
        env: {
          ...env,
          CLOUDFLARE_API_TOKEN: credentials.token,
          CLOUDFLARE_ACCOUNT_ID: credentials.account,
        },
        project,
        branch,
        outputDirectory: "dist/analog/public",
        redact,
      });

      if (!deployment.ok || !deployment.url) {
        return Promise.reject(
          new Error(`wrangler pages deploy of ${side.toUpperCase()} failed: ${deployment.output}`),
        );
      }

      return Promise.resolve({
        immutable: deployment.url,
        record: {
          side,
          project,
          branch,
          url: deployment.url,
          hash: deployment.hash,
          ...(deployment.id ? { id: deployment.id } : {}),
        },
      });
    },
    close: () => Promise.resolve(),
  };
}

async function deploymentPhase(
  target: DeployTarget,
  release: NonNullable<typeof cloudflareRelease>,
  ids: Record<Side, string>,
): Promise<boolean> {
  const deployed = target.kind === "DEPLOYED";
  const tag = deployed ? "deployed" : "rehearsal";
  const alias = target.alias;
  const ok: boolean[] = [];
  const ck = (name: string, passed: boolean, detail?: string): boolean => {
    ok.push(check(`${tag}: ${name}`, passed, detail ? redact(detail) : detail));

    return passed;
  };
  const record: Record<string, unknown> = { kind: target.kind, alias, deployments: [] };
  const immutable = {} as Record<Side, string>;
  const skip = (file: string): boolean => /(^|\/)\.wrangler-/.test(file);

  evidence["deployment"] = record;

  const publish = async (side: Side, step: string): Promise<boolean> => {
    const before = treeDigest(join(release.dirs[side], "dist"), skip);

    ck(
      `${step}: the artifact handed to the deployment is release ${side.toUpperCase()}'s retained build (digest unchanged since its local verification)`,
      before === release.digests[side].tree,
    );

    const result = await target.deploy(side);

    immutable[side] = result.immutable;
    (record["deployments"] as unknown[]).push({ step, ...result.record });

    const readiness = await awaitBuild(alias, ids[side], deployed);

    (record["readiness"] ??= []) as unknown[];
    (record["readiness"] as unknown[]).push({ step, ...readiness });

    return ck(
      `${step}: the alias serves build ${ids[side]} (readiness: ${readiness.attempts} attempt(s), ${readiness.notReady.length} not-ready, kept separate from the assertions)`,
      readiness.ready,
      readiness.notReady.slice(0, 5).join("; "),
    );
  };

  const contract = async (side: Side, step: string): Promise<boolean> => {
    const label = `${tag} ${step}`;
    const http = await httpSuite(alias, label, { lifecycle: false });
    const island = await islandSuite(alias, label);
    const navigation = await navigationSuite(alias, label);
    const html = (await httpGet(`${alias}${PAGE}`)).body;
    const own = (await httpGet(`${immutable[side]}${PAGE}`)).body;

    return all([
      ...http.controller,
      ...http.serverComponents,
      ...island.ok,
      ...navigation,
      ck(`${step}: every boundary on the alias carries ${ids[side]}`, servesBuild(html, ids[side])),
      ck(
        `${step}: the deployment's own immutable URL serves the same build`,
        servesBuild(own, ids[side]),
      ),
      ck(`${step}: no private canary in the public document`, leaks(html).length === 0),
    ]);
  };

  section(`${target.kind}: deploy A → verify → deploy B → stale clients → restore A (${alias})`);

  // D1 — release A.
  if (!(await publish("a", "D1 deploy A"))) return false;
  ck("D1 release A: full-stack contract on the alias", await contract("a", "D1 A"));

  // D2 — a tab that loaded A stays open across the upgrade.
  const tab = await visit();

  await tab.page.goto(`${alias}${PAGE}`);
  const onA = await settled(tab.page, 1);

  ck(
    "D2 a tab on A: hydrated over the SSR nodes and interactive",
    onA.hydratedHosts === 1 && onA.errors.length === 0 && (await interactive(tab)),
    JSON.stringify(onA.errors),
  );

  // D3 — release B.
  if (!(await publish("b", "D3 deploy B"))) {
    await tab.close();

    return false;
  }
  ck("D3 release B: full-stack contract on the alias", await contract("b", "D3 B"));
  ck(
    "D3 the previous deployment (A) is still served unchanged at its immutable URL",
    servesBuild((await httpGet(`${immutable.a}${PAGE}`)).body, ids.a),
  );

  // D4 — the open A tab after the upgrade: same controller API, then a document navigation.
  ck(
    "D4 the A tab still works against B's controller API (one click, one request, the answer reaches the DOM)",
    await interactive(tab),
  );
  await tab.page.goto(`${alias}${PAGE}?recovery=reload`);
  const tabOnB = await settled(tab.page, 1);
  const stampsB = await tab.page.evaluate(
    "[...document.querySelectorAll('[data-strata-build]')].map((n) => n.getAttribute('data-strata-build'))",
  );

  ck(
    "D4 a document navigation in the A tab loads B's document and B's scripts: hydrated, no refusal, no reload",
    tabOnB.hydratedHosts === 1 &&
      tabOnB.errors.length === 0 &&
      JSON.stringify(stampsB) === JSON.stringify([ids.b]) &&
      tabOnB.record === null,
    JSON.stringify({ tabOnB, stampsB }),
  );
  await tab.page.goto(`${alias}/about`);
  await tab.page.goBack();
  const back = await settled(tab.page, 1);

  await tab.page.goForward();
  await tab.page.waitForURL("**/about");
  await tab.page.goBack();
  const again = await settled(tab.page, 1);

  ck(
    "D4 Back, Forward and Back again stay hydrated with no unexpected exception",
    back.hydratedHosts === 1 &&
      back.errors.length === 0 &&
      again.hydratedHosts === 1 &&
      unexpected(tab, again).length === 0,
    unexpected(tab, again).join(" | "),
  );
  await tab.close();

  // D5–D7 — stale A assets (A's real deployed files) with B's document.
  const staleScenario = async (html: Side, assets: Side, step: string): Promise<void> => {
    // Without recovery: refused as a mismatch naming both builds, inert, one document.
    {
      const v = await visit();
      const stale = await staleAssets(v.page.context(), {
        origin: alias,
        previous: immutable[assets],
        documents: "always",
      });

      await v.page.goto(`${alias}${PAGE}`);
      const seen = await settled(v.page, 1);

      ck(
        `${step}: ${html.toUpperCase()} document + ${assets.toUpperCase()}'s deployed scripts, recovery off: refused as build-mismatch naming both builds, nothing hydrated, inert, one document`,
        seen.hydratedHosts === 0 &&
          seen.errors.length === 1 &&
          mismatchNaming(seen.errors[0], ids[assets], ids[html]) &&
          (await inert(v)) &&
          v.documents.length === 1 &&
          stale.served.length > 0,
        JSON.stringify({ errors: seen.errors, served: stale.served.length }),
      );
      ck(
        `${step}: no unexpected exception and no private canary in the DOM or console`,
        unexpected(v, await observe(v.page)).length === 0 &&
          leaks(await v.page.evaluate("document.documentElement.outerHTML"), v.console.join("\n"))
            .length === 0,
        unexpected(v, seen).join(" | "),
      );
      await stale.dispose();
      await v.close();
    }
    // Recovery on, cache converges after one document: exactly one reload, then healthy.
    {
      const v = await visit();
      const stale = await staleAssets(v.page.context(), {
        origin: alias,
        previous: immutable[assets],
        documents: 1,
      });

      await v.page.goto(`${alias}${PAGE}?recovery=reload`);
      await until(() => v.documents.length >= 2, 30_000, 40);
      const seen = await settled(v.page, 1);

      ck(
        `${step}: recovery on, converging cache: exactly one bounded reload, then ${html.toUpperCase()} hydrates and is interactive`,
        v.documents.length === 2 &&
          seen.hydratedHosts === 1 &&
          seen.errors.length === 0 &&
          /^\{"count":1,"since":\d+\}$/.test(seen.record ?? "") &&
          (await interactive(v)),
        JSON.stringify({ documents: v.documents.length, seen }),
      );
      await stale.dispose();
      await v.close();
    }
    // Recovery on, skew persists: one reload, then "exhausted"; no loop.
    {
      const v = await visit();
      const stale = await staleAssets(v.page.context(), {
        origin: alias,
        previous: immutable[assets],
        documents: "always",
      });

      await v.page.goto(`${alias}${PAGE}?recovery=reload`);
      await until(() => v.documents.length >= 2, 30_000, 40);
      const refused = await until(
        async () => {
          const now = await observe(v.page).catch(() => undefined);

          return now && now.errors.length > 0 ? now : undefined;
        },
        30_000,
        50,
      );

      await v.page.waitForLoadState("networkidle");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      ck(
        `${step}: recovery on, persistent skew: exactly one reload, then "exhausted"; the page stays inert SSR and no reload loop`,
        v.documents.length === 2 &&
          refused?.errors.length === 1 &&
          refused.errors[0]?.recovery === "exhausted" &&
          refused.hydratedHosts === 0 &&
          (await inert(v)),
        JSON.stringify({ documents: v.documents.length, errors: refused?.errors }),
      );
      await stale.dispose();
      await v.close();
    }
  };

  await staleScenario("b", "a", "D5 upgrade skew");

  // D8 — rollback: restore A's retained artifact (never a rebuild).
  if (!(await publish("a", "D8 restore A"))) return false;
  ck("D8 rolled-back release A: full-stack contract on the alias", await contract("a", "D8 A"));
  await staleScenario("a", "b", "D8 rollback skew");

  // D9 — public surface confidentiality and edge consistency of the final state.
  const surface = failureCount();

  await surfaceSuite(alias, `${tag} D9`);
  ck(
    "D9 public surface confidentiality (documents, assets, maps, headers)",
    failureCount() === surface,
  );

  const matrix = await runConcurrencyMatrix(alias, {
    target: tag,
    stabilizeMs: deployed ? 10_000 : 0,
    // The matrix's own hard ceiling (MAX_REQUESTS_PER_URL); it can only be lowered, never raised.
    requestBudget: MAX_REQUESTS_PER_URL,
  });

  record["edge"] = {
    verdict: matrix.verdict,
    reproduced: matrix.reproduced,
    requestsIssued: matrix.requestsIssued,
    requestBudget: matrix.requestBudget,
    anomalies: matrix.anomalies,
    firstSamples: matrix.firstSamples,
    rounds: matrix.rounds.map((r) => ({
      label: r.label,
      requests: r.requests,
      classes: r.classes,
      statuses: r.statuses,
    })),
  };
  ck(
    `D9 edge consistency: ${matrix.requestsIssued} requests (budget ${matrix.requestBudget}), ${matrix.anomalies} anomalies, no retries (${matrix.reproduced})`,
    matrix.verdict === "GO",
    JSON.stringify(matrix.firstSamples.slice(0, 3)),
  );

  record["verdict"] = all(ok) ? "GO" : "NO-GO";

  return all(ok);
}

// ---------------------------------------------------------------------------

try {
  let pair;
  let ids;

  try {
    pair = selectedPair(process.env);
    ids = selectedBuildIds(process.env);
    if (![ids.a, ids.b].every(isValidBuildId) || ids.a === ids.b) {
      throw new Error(`build ids must be valid and distinct: ${ids.a}, ${ids.b}`);
    }
  } catch (error) {
    console.error(`invalid selection: ${error instanceof Error ? error.message : String(error)}`);
    rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(2);
  }

  const browserTool = await chromium.launch();

  browser = browserTool;

  section("Selected release pair (exact published versions; nothing substituted)");
  for (const side of SIDES) {
    console.log(
      `release ${side.toUpperCase()}: ${TUPLE_LIST.map((n) => `${n}@${pair[side][n]}`).join(", ")}  buildId ${ids[side]}`,
    );
  }
  check(
    "the two releases are different deployments: distinct, valid application build ids",
    ids.a !== ids.b && isValidBuildId(ids.a) && isValidBuildId(ids.b),
  );
  check(
    "the build ids are labels of the deployment, not package versions",
    SIDES.every((side) => TUPLE_LIST.every((name) => !ids[side].includes(pair[side][name]))),
  );
  evidence["selection"] = {
    pair,
    buildIds: ids,
    envNames: Object.fromEntries(SIDES.map((s) => [s, TUPLE_LIST.map((n) => pairEnvName(s, n))])),
  };

  // -------------------------------------------------------------------------
  const missing: string[] = [];
  const looked = {} as Record<Side, ReturnType<typeof lookupTuple>>;

  for (const side of SIDES) {
    mkdirSync(join(tmpRoot, side), { recursive: true });
    looked[side] = lookupTuple(pair[side], env, join(tmpRoot, side));
    if (looked[side].status === "not-available") {
      missing.push(...(looked[side] as { missing: readonly string[] }).missing);
    } else if (looked[side].status === "error") {
      throw new Error(`registry lookup failed: ${(looked[side] as { detail: string }).detail}`);
    }
  }
  if (missing.length > 0) throw new NotAvailable([...new Set(missing)]);

  const installs = {} as Record<Side, RegistryInstall>;
  const consumerDirs = {} as Record<Side, string>;

  for (const side of SIDES) {
    section(`Release ${side.toUpperCase()}: external install from the registry`);
    consumerDirs[side] = join(tmpRoot, side, "consumer");
    const lookup = looked[side];

    if (lookup.status !== "available") throw new Abort();
    check(
      `release ${side.toUpperCase()}: @strata-sc/analog pins the selected @strata-sc/core (registry metadata)`,
      tupleProblems(pair[side], lookup.artifacts).length === 0,
      tupleProblems(pair[side], lookup.artifacts).join("; "),
    );
    installs[side] = installRegistryConsumer({
      tmpRoot: join(tmpRoot, side),
      consumerDir: consumerDirs[side],
      env,
      time,
      tuple: pair[side],
      artifacts: lookup.artifacts,
    });
    check(`release ${side.toUpperCase()}: install verified`, installs[side].ok);
    tscDeclarations(consumerDirs[side], `release ${side.toUpperCase()} TypeScript 6`, env);
  }

  section("Attribution: only the Strata packages differ between A and B");

  const lockOf = (side: Side): Record<string, LockEntry> =>
    (
      JSON.parse(readFileSync(join(consumerDirs[side], "package-lock.json"), "utf8")) as {
        packages: Record<string, LockEntry>;
      }
    ).packages;
  const nonStrata = (side: Side): string[] =>
    Object.entries(lockOf(side))
      .filter(([key]) => !key.includes("@strata-sc/"))
      .map(([key, entry]) => `${key}|${entry.version}|${entry.integrity}`)
      .sort();
  const sourceDigest = (side: Side): string =>
    treeDigest(join(consumerDirs[side], "src"), (file) => file.startsWith("generated/"));
  const differing = (() => {
    const a = nonStrata("a");
    const b = new Set(nonStrata("b"));

    return a.filter((line) => !b.has(line));
  })();
  const strataDiff = TUPLE_LIST.map((name) => {
    const rel = (side: Side): string => join(consumerDirs[side], "node_modules", name);
    const a = new Set(listFiles(rel("a")));
    const b = new Set(listFiles(rel("b")));
    const files = [...new Set([...a, ...b])].filter(
      (file) =>
        !a.has(file) ||
        !b.has(file) ||
        fileDigest(join(rel("a"), file)) !== fileDigest(join(rel("b"), file)),
    );

    return { name, files };
  });

  check(
    "the consumer source is byte-identical in both installations (version differences are attributable to the packages)",
    sourceDigest("a") === sourceDigest("b"),
  );
  check(
    "every non-Strata package (Angular, Analog, Vite, Nitro, TypeScript, wrangler, …) resolves to the same version and integrity in both locks",
    differing.length === 0 && nonStrata("a").length === nonStrata("b").length,
    differing.slice(0, 6).join(", "),
  );
  check(
    "the Angular/Analog/Vite/Nitro/TypeScript/wrangler tuple is identical in both installations",
    JSON.stringify(installs.a.tuple) === JSON.stringify(installs.b.tuple),
  );
  for (const diff of strataDiff) {
    console.log(
      `${diff.name}: ${diff.files.length} differing file(s) ${diff.files.slice(0, 6).join(", ")}`,
    );
  }
  evidence["installed"] = {
    tuple: installs.a.tuple,
    packages: Object.fromEntries(SIDES.map((side) => [side, installs[side].evidence.packages])),
    strataPackageDiff: strataDiff,
    sourceDigest: sourceDigest("a"),
  };

  // -------------------------------------------------------------------------
  for (const runtime of runtimes) {
    const preset = runtime === "cloudflare" ? "cloudflare" : "node";
    const label = runtime === "cloudflare" ? "workerd" : "node";
    const title =
      runtime === "cloudflare" ? "LOCAL workerd (wrangler pages dev)" : "Nitro Node production";
    const releasesDir = join(tmpRoot, "releases");
    const outcome = perRuntime(runtime);

    section(`${title}: independent production builds of A and B`);

    const dirs = {} as Record<Side, string>;
    const digests = {} as Record<Side, { tree: string; entry: string }>;

    const skip = (file: string): boolean => /(^|\/)\.wrangler-/.test(file);

    for (const side of SIDES) {
      const built = time(`build ${side.toUpperCase()} (${runtime})`, () =>
        buildInstalledRelease({
          consumerDir: consumerDirs[side],
          releasesDir,
          name: side,
          buildId: ids[side],
          preset,
          env,
        }),
      );
      dirs[side] = built.directory;
      digests[side] = {
        tree: treeDigest(join(built.directory, "dist"), skip),
        entry: fileDigest(join(built.directory, "dist", "analog", "public", "assets", "entry.js")),
      };
      console.log(
        `${side.toUpperCase()}: dist digest ${digests[side].tree}; entry.js ${digests[side].entry}`,
      );
    }
    check(
      "the two builds are different artifacts (distinct dist digests and entry scripts)",
      digests.a.tree !== digests.b.tree && digests.a.entry !== digests.b.entry,
    );
    outcome["digests"] = digests;
    if (runtime === "cloudflare")
      cloudflareRelease = { dirs: { ...dirs }, digests: { ...digests } };

    const clientRoots = ["client", "analog/public"];

    for (const side of SIDES) {
      const dist = join(dirs[side], "dist");
      const other = ids[side === "a" ? "b" : "a"];
      const own = filesContaining(dist, clientRoots, [ids[side]]).filter(
        (file) => !file.includes("_worker.js"),
      );
      const foreign = filesContaining(dist, clientRoots, [other]);

      check(
        `release ${side.toUpperCase()}: its build id is in the browser script (positive control) and the other release's is nowhere in it`,
        own.length > 0 && foreign.length === 0,
        `${own.length} files; foreign: ${foreign.join(", ")}`,
      );
    }

    // ---------------------------------------------------------------------
    const start = (side: Side): Promise<RunningServer> =>
      runtime === "cloudflare"
        ? startWrangler(dirs[side], env, PAGE)
        : startNodeServer(dirs[side], env);

    /** The complete full-stack contract against one running release. */
    const contract = async (side: Side, server: RunningServer, phase: string): Promise<boolean> => {
      const tag = `${label} ${phase}`;
      const base = server.baseUrl;
      const lifecycle = { lifecycle: true, log: () => server.output() };
      const http = await httpSuite(base, tag, lifecycle);
      const island = await islandSuite(base, tag);
      const navigation = await navigationSuite(base, tag);
      const routing = [
        ...(await routingSuite(base, tag, lifecycle)),
        ...(await routingBrowserSuite(base, tag)),
      ];
      const extra: boolean[] = [];
      const record = (name: string, passed: boolean, detail?: string): boolean => {
        extra.push(check(name, passed, detail));

        return passed;
      };

      await observeStreaming(base, label, record);
      await observeCorrelation(base, label, record);

      const html = (await httpGet(`${base}${PAGE}`)).body;
      const stamps = [...html.matchAll(/data-strata-build="([^"]*)"/g)].map((m) => m[1]);

      extra.push(
        check(
          `${tag}: the served document carries this release's build id on every boundary, and only that one`,
          stamps.length >= 1 && stamps.every((id) => id === ids[side]),
          stamps.join(","),
        ),
        check(
          `${tag}: server output carries no log line with a private canary`,
          leaks(sanitize(server.output())).length === 0,
        ),
      );

      return all([
        ...http.controller,
        ...http.serverComponents,
        ...island.ok,
        ...navigation,
        ...routing,
        ...extra,
      ]);
    };

    const graphs = (side: Side): boolean => {
      const dist = join(dirs[side], "dist");
      const server =
        preset === "cloudflare" ? ["analog/public/_worker.js"] : ["analog/server", "ssr"];
      const publicRoots = clientRoots;
      const browserLeaks = filesContaining(dist, publicRoots, PRIVATE_CANARIES).filter(
        (file) => !file.includes("_worker.js"),
      );
      const sourceLeaks = filesContaining(dist, publicRoots, [
        ...FULL_STACK_SERVER_SOURCES.filter((f) => f !== "product-details.server-component.ts"),
      ]).filter((file) => !file.includes("_worker.js"));
      const serverHas = SERVER_ONLY_MARKERS.map(
        (marker) => filesContaining(dist, server, [marker]).length > 0,
      );

      return all([
        check(
          `release ${side.toUpperCase()} (${label}): no private canary in any browser script, asset or source map`,
          browserLeaks.length === 0,
          browserLeaks.join(", "),
        ),
        check(
          `release ${side.toUpperCase()} (${label}): no consumer server source name in a browser file or map`,
          sourceLeaks.length === 0,
          sourceLeaks.join(", "),
        ),
        check(
          `release ${side.toUpperCase()} (${label}): every server-only marker is in the server graph (positive control)`,
          serverHas.every(Boolean),
        ),
      ]);
    };

    // ---------------------------------------------------------------------
    // B, D: each release on its own.
    for (const side of SIDES) {
      section(`${title}: release ${side.toUpperCase()} verified independently`);

      const server = await start(side);

      servers.push(server);
      const ok = await contract(side, server, `release ${side.toUpperCase()}`);

      await server.stop();
      servers.length = 0;
      outcome[`independent-${side}`] = ok && graphs(side);
      check(`release ${side.toUpperCase()} (${label}): full-stack contract`, ok);
    }

    // ---------------------------------------------------------------------
    section(`${title}: two-build edge — upgrade, skew, recovery, rollback`);

    const upstreams = {} as Record<Side, string>;

    for (const side of SIDES) {
      const server = await start(side);

      servers.push(server);
      upstreams[side] = server.baseUrl;
    }

    const documents = {} as Record<Side, string>;

    for (const side of SIDES) documents[side] = (await httpGet(`${upstreams[side]}${PAGE}`)).body;
    const entries = SIDES.map((side) => entryScript(documents[side]));
    const entryBodies = await Promise.all(
      SIDES.map(async (side) => (await httpGet(`${upstreams[side]}/assets/entry.js`)).body),
    );

    check(
      "both releases name one stable browser entry URL whose content differs per release",
      entries.every((entry) => entry === "/assets/entry.js") &&
        entryBodies[0] !== entryBodies[1] &&
        entryBodies.every((body) => body.length > 10_000),
      JSON.stringify(entries),
    );

    edge = new Edge({ upstreams });
    await edge.start();

    const activeEdge = edge;
    const url = (path = PAGE): string => `${activeEdge.baseUrl}${path}`;
    const same = (release: Release): Plan => ({ html: release, assets: release });
    const classified = (
      error: Observed["errors"][number] | undefined,
      browserId: string,
      serverId: string,
    ): boolean =>
      error?.name === "StrataBuildMismatchError" &&
      error.category === "build-mismatch" &&
      error.message.includes(`"${browserId}"`) &&
      error.message.includes(`"${serverId}"`);

    const scenarioOk: boolean[] = [];
    const ck = (name: string, passed: boolean, detail?: string): void => {
      scenarioOk.push(check(name, passed, detail));
    };

    // Positive controls: same-release combinations.
    for (const side of SIDES) {
      activeEdge.scenario([same(side)]);
      const v = await visit();

      await v.page.goto(url());
      const seen = await settled(v.page, 1);

      ck(
        `${side.toUpperCase()} HTML + ${side.toUpperCase()} assets: the island hydrates over the SSR nodes, no refusal, committed observation`,
        seen.hydratedHosts === 1 &&
          seen.errors.length === 0 &&
          seen.mismatches.length === 0 &&
          seen.sameNodes &&
          seen.hydrationObservations.length === 1 &&
          seen.hydrationObservations[0]?.outcome === "committed",
        JSON.stringify(seen),
      );
      ck(
        `${side.toUpperCase()}: the island is interactive (one click, one controller request)`,
        await interactive(v),
      );
      ck(
        `${side.toUpperCase()}: no console error, page error or unhandled rejection; one document request`,
        unexpected(v, await observe(v.page)).length === 0 &&
          v.console.length === 0 &&
          activeEdge.requests.length === 1,
        unexpected(v, seen).join(" | "),
      );
      await v.close();
    }

    // Mismatches in both directions (F, G): the document and the scripts are genuine artifacts.
    for (const [html, assets] of [
      ["b", "a"],
      ["a", "b"],
    ] as const) {
      const step = html === "b" ? "F (upgrade, stale A assets)" : "G (stale B assets)";

      activeEdge.scenario([{ html, assets }]);
      const v = await visit();

      await v.page.goto(url());
      const seen = await settled(v.page, 1);
      const browserId = ids[assets];
      const serverId = ids[html];

      ck(
        `${step}: ${html.toUpperCase()} HTML + ${assets.toUpperCase()} assets is refused as build-mismatch naming both builds; nothing is instantiated`,
        seen.hydratedHosts === 0 &&
          seen.errors.length === 1 &&
          classified(seen.errors[0], browserId, serverId),
        JSON.stringify(seen.errors),
      );
      ck(
        `${step}: one classified preflight observation (build-mismatch, recovery disabled, 0 committed) and the public ids reach onMismatch`,
        seen.hydrationObservations.length === 1 &&
          seen.hydrationObservations[0]?.outcome === "preflight-refused" &&
          seen.hydrationObservations[0]?.failureCategory === "build-mismatch" &&
          seen.hydrationObservations[0]?.buildMismatch === true &&
          seen.hydrationObservations[0]?.recoveryOutcome === "disabled" &&
          seen.hydrationObservations[0]?.committedBoundaries === 0 &&
          JSON.stringify(seen.mismatches) ===
            JSON.stringify([{ browserBuildId: browserId, serverBuildId: serverId }]),
        JSON.stringify({ o: seen.hydrationObservations, m: seen.mismatches }),
      );
      ck(
        `${step}: the SSR DOM stays visible and inert; recovery is off so there is no reload and no storage record`,
        seen.titles[0] === "Product 42" &&
          seen.statuses[0] === "Availability: not checked" &&
          (await inert(v)) &&
          seen.record === null &&
          activeEdge.requests.length === 1,
      );
      await v.page.waitForLoadState("networkidle");
      ck(
        `${step}: no unexpected browser exception or unhandled rejection; exactly one document request; no canary in the DOM or console`,
        unexpected(v, await observe(v.page)).length === 0 &&
          activeEdge.requests.length === 1 &&
          v.documents.length === 1 &&
          leaks(await v.page.evaluate("document.documentElement.outerHTML"), v.console.join("\n"))
            .length === 0,
        unexpected(v, seen).join(" | "),
      );
      await v.close();
    }

    // Healthy sibling host beside a host rendered by the other release.
    for (const [own, foreign] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      activeEdge.scenario([same(own)], { splice: { path: "/pair", host: 1, from: foreign } });
      const v = await visit();

      await v.page.goto(url("/pair"));
      const seen = await settled(v.page, 2);

      ck(
        `sibling hosts (${own.toUpperCase()} assets): host 1 hydrates, host 2 (rendered by ${foreign.toUpperCase()}) is refused as a mismatch`,
        seen.hydratedHosts === 1 &&
          seen.errors.length === 1 &&
          classified(seen.errors[0], ids[own], ids[foreign]),
        JSON.stringify(seen),
      );
      ck(
        "the healthy sibling stays interactive; the refused host stays inert; no reload without opt-in",
        (await interactive(v, 0)) && (await inert(v, 1)) && activeEdge.requests.length === 1,
      );
      ck(
        "no unexpected exception",
        unexpected(v, await observe(v.page)).length === 0,
        unexpected(v, seen).join(" | "),
      );
      await v.close();
    }

    // Opt-in recovery: converged and non-converged, both directions (H, I).
    for (const [html, assets] of [
      ["a", "b"],
      ["b", "a"],
    ] as const) {
      const target = html;
      const step = html === "b" ? "upgrade" : "rollback";

      activeEdge.scenario([{ html, assets }, same(target)]);
      const converged = await visit();

      await converged.page.goto(url(`${PAGE}?recovery=reload`));
      await until(() => activeEdge.requests.length >= 2, 30_000, 40);
      const seen = await settled(converged.page, 1);

      ck(
        `H (${step}): ${html.toUpperCase()} HTML + ${assets.toUpperCase()} assets, recovery on, the edge converges: exactly one reload to a ${target.toUpperCase()} document, the island hydrates`,
        activeEdge.requests.length === 2 &&
          activeEdge.requests[1]?.plan.html === target &&
          seen.hydratedHosts === 1 &&
          seen.errors.length === 0 &&
          seen.sameNodes,
        JSON.stringify({ requests: activeEdge.requests, seen }),
      );
      ck(
        `H (${step}): the reload targets the same URL and the tab record holds only a counter and a timestamp`,
        activeEdge.requests.every((r) => r.path === `${PAGE}?recovery=reload`) &&
          /^\{"count":1,"since":\d+\}$/.test(seen.record ?? ""),
        seen.record ?? "",
      );
      ck(`H (${step}): the recovered island is interactive`, await interactive(converged));
      await converged.close();

      activeEdge.scenario([{ html, assets }]);
      const stuck = await visit();

      await stuck.page.goto(url(`${PAGE}?recovery=reload`));
      await until(() => activeEdge.requests.length >= 2, 30_000, 40);
      const refused = await until(
        async () => {
          const now = await observe(stuck.page).catch(() => undefined);

          return now && now.errors.length > 0 ? now : undefined;
        },
        30_000,
        50,
      );

      await stuck.page.waitForLoadState("networkidle");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      ck(
        `I (${step}): skew persists, recovery on: exactly one reload, then the error says "exhausted"; the page stays inert SSR and no further request is made`,
        activeEdge.requests.length === 2 &&
          refused?.errors.length === 1 &&
          refused.errors[0]?.recovery === "exhausted" &&
          refused.hydratedHosts === 0 &&
          (await inert(stuck)),
        JSON.stringify({ requests: activeEdge.requests.length, errors: refused?.errors }),
      );
      await stuck.page.reload();
      await settled(stuck.page, 1);
      await stuck.page.waitForLoadState("networkidle");
      ck(
        `I (${step}): a manual reload inside the window is not followed by another automatic one (no reload loop)`,
        activeEdge.requests.length === 3 &&
          unexpected(stuck, await observe(stuck.page)).length === 0,
        String(activeEdge.requests.length),
      );
      await stuck.close();
    }

    // The full sequence A → B → A in one tab (E–K).
    {
      activeEdge.scenario([same("a")]);
      const v = await visit();

      await v.page.goto(url(`${PAGE}?recovery=reload`));
      const onA = await settled(v.page, 1);

      ck(
        "E0: release A is live: hydrated and interactive",
        onA.hydratedHosts === 1 && (await interactive(v)),
      );

      // E: the deployment switches to B. The CDN still holds A's scripts for one document, then converges.
      await v.page.goto(url("/about"));
      activeEdge.next([{ html: "b", assets: "a" }, same("b")]);
      await v.page.goto(url(`${PAGE}?recovery=reload`));
      await until(
        () => activeEdge.requests.filter((r) => r.path.startsWith(PAGE)).length >= 3,
        30_000,
        40,
      );
      const onB = await settled(v.page, 1);

      ck(
        "E/F/H: upgrade A→B with stale A scripts: B's document is recognised as a mismatch, one bounded reload, B hydrates and is interactive",
        onB.hydratedHosts === 1 &&
          onB.errors.length === 0 &&
          activeEdge.requests.filter((r) => r.path.startsWith(PAGE)).length === 3 &&
          (await interactive(v)),
        JSON.stringify(onB),
      );

      // J: roll back B → A: A's document with the stale B scripts, then convergence on A.
      await v.page.goto(url("/about"));
      activeEdge.next([{ html: "a", assets: "b" }, same("a")]);
      await v.page.evaluate("sessionStorage.removeItem('strata:skew-recovery')");
      await v.page.goto(url(`${PAGE}?recovery=reload`));
      await until(
        () => activeEdge.requests.filter((r) => r.path.startsWith(PAGE)).length >= 5,
        30_000,
        40,
      );
      const rolled = await settled(v.page, 1);

      ck(
        "J: rollback B→A with stale B scripts: A's document is recognised as a mismatch, one bounded reload, A hydrates",
        rolled.hydratedHosts === 1 &&
          rolled.errors.length === 0 &&
          activeEdge.requests.filter((r) => r.path.startsWith(PAGE)).length === 5 &&
          activeEdge.requests.at(-1)?.plan.html === "a",
        JSON.stringify(rolled),
      );

      // K: healthy interaction and navigation after the rollback.
      ck("K: the rolled-back island is interactive", await interactive(v));
      await v.page.goto(url("/about"));
      await v.page.goBack();
      await v.page.waitForLoadState("load");
      const back = await settled(v.page, 1);

      ck(
        "K: Back returns to a hydrated product page; Forward and Back again stay healthy",
        back.hydratedHosts === 1 && back.errors.length === 0,
        JSON.stringify(back),
      );
      await v.page.goForward();
      await v.page.waitForURL("**/about");
      await v.page.goBack();
      const again = await settled(v.page, 1);

      ck(
        "K: no unexpected exception across the whole sequence",
        again.hydratedHosts === 1 &&
          unexpected(v, again).length === 0 &&
          leaks(v.console.join("\n")).length === 0,
        unexpected(v, again).join(" | "),
      );
      await v.close();
    }

    // Negative controls: the verifier must catch deliberately broken cases.
    {
      const stripped: Rewrite = (html) => html.replaceAll(/data-strata-build="[^"]*"/g, "");

      activeEdge.scenario([same("a")], { rewrite: stripped });
      const v = await visit();

      await v.page.goto(url(`${PAGE}?recovery=reload`));
      const seen = await settled(v.page, 1);

      ck(
        "NEGATIVE CONTROL (edited document, identity removed): classified build-identity, never a hydration and never a reload",
        seen.hydratedHosts === 0 &&
          seen.errors[0]?.category === "build-identity" &&
          seen.record === null &&
          activeEdge.requests.length === 1,
        JSON.stringify(seen.errors),
      );
      await v.close();

      const forged: Rewrite = (html) => html.replaceAll(ids.a, ids.b);

      activeEdge.scenario([same("a")], { rewrite: forged });
      const w = await visit();

      await w.page.goto(url());
      const forgedSeen = await settled(w.page, 1);

      ck(
        "NEGATIVE CONTROL (A's document forged to claim B's id, A's scripts): refused as a mismatch, so the verifier does distinguish identities",
        forgedSeen.hydratedHosts === 0 && classified(forgedSeen.errors[0], ids.a, ids.b),
        JSON.stringify(forgedSeen.errors),
      );
      await w.close();

      // The predicates themselves fail on wrong input.
      const healthy = await (async () => {
        activeEdge.scenario([same("a")]);
        const h = await visit();

        await h.page.goto(url());
        const result = await settled(h.page, 1);

        await h.close();

        return result;
      })();

      ck(
        "NEGATIVE CONTROL (verifier self-test): a healthy hydration is NOT classified as a mismatch, and a refusal is NOT accepted as healthy",
        !classified(healthy.errors[0], ids.a, ids.b) &&
          !(healthy.hydratedHosts === 0) &&
          healthy.errors.length === 0,
      );
    }

    await edge.stop();
    edge = undefined;
    for (const server of servers.splice(0)) await server.stop();
    outcome["edge"] = all(scenarioOk);

    // ---------------------------------------------------------------------
    section(`${title}: rollback — release A restarted from its own artifact`);

    const after = treeDigest(join(dirs.a, "dist"), skip);

    check(
      "release A's artifact is byte-identical to the one first verified (rollback restores, never rebuilds)",
      after === digests.a.tree,
    );

    const rollback = await start("a");

    servers.push(rollback);
    const rollbackOk = await contract("a", rollback, "rollback to A");

    await rollback.stop();
    servers.length = 0;
    outcome["rollback"] = rollbackOk;
    check(`rollback to A (${label}): full-stack contract`, rollbackOk);
  }
  // -------------------------------------------------------------------------
  if (cloudflareRelease && REHEARSE) {
    const deploymentEvidence: Record<string, string> = {};

    evidence["deploymentVerdicts"] = deploymentEvidence;

    const rehearsal = await rehearsalTarget(cloudflareRelease.dirs);
    let rehearsed = false;

    try {
      rehearsed = await deploymentPhase(rehearsal, cloudflareRelease, ids);
    } finally {
      await rehearsal.close();
    }
    deploymentEvidence["LOCAL REHEARSAL"] = rehearsed ? "GO" : "NO-GO";
    evidence["rehearsal"] = evidence["deployment"];

    if (!DEPLOY) {
      deploymentEvidence["DEPLOYED"] = "NOT RUN (STRATA_UPGRADE_DEPLOY is not 1)";
    } else if (!rehearsed || failureCount() > 0) {
      deploymentEvidence["DEPLOYED"] = "NOT RUN (local qualification or rehearsal failed)";
      check("the real deployment runs only after every local check passed", false);
    } else if (!credentials.token || !credentials.account) {
      deploymentEvidence["DEPLOYED"] = "NOT RUN (missing Cloudflare credentials)";
      check(
        "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set (values never printed)",
        !REQUIRE_DEPLOYED,
      );
    } else {
      const deployedOk = await deploymentPhase(
        pagesTarget(cloudflareRelease.dirs),
        cloudflareRelease,
        ids,
      );

      deploymentEvidence["DEPLOYED"] = deployedOk ? "GO" : "NO-GO";
    }
    console.log(`\ndeployment-aware verdicts: ${JSON.stringify(deploymentEvidence)}`);
  }
} catch (error) {
  if (error instanceof NotAvailable) {
    notAvailable = error;
  } else if (!(error instanceof Abort)) {
    check(
      "the qualification ran to completion",
      false,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
} finally {
  await browser?.close().catch(() => undefined);
  await edge?.stop().catch(() => undefined);
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);

  console.log(`\ntimings: ${timings.join("; ")}`);
  if (process.env["STRATA_UPGRADE_EVIDENCE"]) {
    writeFileSync(process.env["STRATA_UPGRADE_EVIDENCE"], `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (process.env["STRATA_KEEP_CONSUMER"] === "1") {
    console.log(`kept: ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

if (notAvailable) {
  console.log(`\nPUBLISHED-REGISTRY: NOT AVAILABLE — ${notAvailable.missing.join(", ")}`);
  console.log(
    "A selected version is not on the npm registry. This is not a runtime qualification failure and not a GO; nothing was substituted.",
  );
  process.exit(3);
}

finish(TITLE);
