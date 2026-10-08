import { chromium } from "playwright";

import {
  Edits,
  GENERATED_DIR,
  devFile,
  sameSnapshot,
  snapshotDir,
  startDevServer,
  strataLogLines,
} from "./lib/dev-harness.ts";
import type { DevContext } from "./lib/dev.ts";
import {
  checkBoundaryLifecycle,
  checkClientEdit,
  checkCreateAndDelete,
  checkDynamicAndQuery,
  checkInitialDev,
  checkInvalidEdit,
  checkLiveBarrel,
  checkLiveServerOnly,
  checkRepeatedEdits,
  checkServerOwnedEdits,
  refreshTimings,
  restoreAndSettle,
} from "./lib/dev.ts";
import { check, finish, section } from "./lib/harness.ts";
import { printFrameworkTuple } from "./lib/security.ts";

/**
 * `pnpm test:server-component-dev`: Server Component graph regeneration and
 * reload semantics under the REAL Analog/Vite dev server
 * (docs/research/server-component-dev-hmr.md), in Chromium.
 *
 *   server-owned change  → regenerate the graph → ONE document reload
 *   client-owned change  → graph unchanged     → the framework's own update path
 *   invalid graph        → Strata diagnostic, client graph fails closed
 *   fix                  → recovery without restarting Vite
 *
 * The scenarios edit `apps/analog-fixture/src/app/server-component-dev/*`
 * (and the page that renders them) while `vite` runs, and restore every byte.
 */

const TITLE = "Server Component dev server: graph regeneration, reload semantics, live firewall";
const stop = (): never => finish(TITLE);
const verdict: Record<string, boolean> = {};
const timings: number[] = [];

printFrameworkTuple();

const edits = new Edits();
const browser = await chromium.launch();

try {
  section("Dev server (Analog default: liveReload off)");

  const server = await startDevServer();

  try {
    const context: DevContext = {
      server,
      browser,
      edits,
      baseline: snapshotDir(GENERATED_DIR),
    };

    verdict["A initial dev graph"] = await checkInitialDev(context);
    verdict["B/C/D server-owned edits reload the document"] = await checkServerOwnedEdits(context);
    verdict["E/F boundary added, swapped, removed"] = await checkBoundaryLifecycle(context);
    verdict["G client edit: Strata forces no reload (stock Analog)"] = await checkClientEdit(
      context,
      "stock",
    );
    verdict["H server-only assertion added live"] = await checkLiveServerOnly(context);
    verdict["H2 dynamic import and ?raw/?url firewalled live"] =
      await checkDynamicAndQuery(context);
    verdict["I barrel becomes server-only live"] = await checkLiveBarrel(context);

    verdict["J invalid @defer: diagnostic, then recovery"] = await checkInvalidEdit(
      context,
      "J. Invalid server-owned @defer → diagnostic → fix recovers",
      () =>
        edits.replace(
          devFile("dev-child.component.ts"),
          "<dev-note />`",
          "<dev-note />\n    @defer {<p>late</p>}`",
        ),
      /@defer block in server-only component DevChildComponent/,
    );
    verdict["K invalid event binding: diagnostic, then recovery"] = await checkInvalidEdit(
      context,
      "K. Invalid server-owned event binding → diagnostic → fix recovers",
      () => {
        edits.replace(
          devFile("dev-child.component.ts"),
          "<dev-note />`",
          '<button type="button" (click)="noop()">x</button>\n    <dev-note />`',
        );
        edits.replace(
          devFile("dev-child.component.ts"),
          "export class DevChildComponent {}",
          "export class DevChildComponent {\n  protected noop(): void {}\n}",
        );
      },
      /Interactive binding "\(click\)" on <button>/,
    );
    verdict["K2 unresolved [strataClient]: diagnostic, then recovery"] = await checkInvalidEdit(
      context,
      "K2. Unresolved [strataClient] composition → diagnostic → fix recovers",
      () =>
        edits.replace(
          devFile("dev-boundary.server-component.ts"),
          "<aside data-dev-boundary>Boundary host</aside>",
          '<aside data-dev-boundary>Boundary host</aside><dev-island-b [strataClient]="{}" />',
        ),
      /<dev-island-b> is marked \[strataClient\], but no component in imports/,
    );

    verdict["L Server Component created, wired, deleted"] = await checkCreateAndDelete(context);
    verdict["M repeated cycles leave no stale islands"] = await checkRepeatedEdits(context);

    timings.push(...refreshTimings(server.output()));

    section("Server log");
    check("the dev server process never exited", !server.process.hasExited());
    console.log(strataLogLines(server.output()).slice(-12).join("\n"));
  } finally {
    edits.restore();
    await server.stop();
  }

  section("Dev server (Analog liveReload on): Angular component HMR coexistence");

  const hmrServer = await startDevServer({ STRATA_DEV_LIVE_RELOAD: "on" });

  try {
    const context: DevContext = {
      server: hmrServer,
      browser,
      edits,
      baseline: snapshotDir(GENERATED_DIR),
    };

    verdict["G2 client edit: Angular HMR, same realm, no document"] = await checkClientEdit(
      context,
      "liveReload",
    );
    timings.push(...refreshTimings(hmrServer.output()));
    await restoreAndSettle(context);
  } finally {
    edits.restore();
    await hmrServer.stop();
  }
} finally {
  edits.restore();
  await browser.close();
}

section("Working tree");

const problems = edits.verifyRestored();

verdict["every edited path is back to its original bytes"] = check(
  `every touched path is restored byte for byte (${edits.touched.length} paths)`,
  problems.length === 0,
  problems.join(", "),
);

if (timings.length > 0) {
  const sorted = [...timings].sort((a, b) => a - b);

  console.log(
    `\ngraph refresh (analog-fixture, ${timings.length} refreshes): min ${sorted[0]} ms, median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms`,
  );
}

section("Verdict");

for (const [name, passed] of Object.entries(verdict)) {
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}`);
}

if (!Object.values(verdict).every(Boolean)) check("every verdict line above holds", false);

void sameSnapshot;
stop();
