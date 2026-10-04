import {
  checkDeferBrowser,
  checkDeferBundle,
  checkDeferFailsClosed,
  checkDeferGraphs,
  checkDeferSsr,
} from "./lib/defer.ts";
import {
  BROWSER_DIRS,
  SERVER_DIRS,
  build,
  check,
  dirGraph,
  finish,
  section,
  startProductionServer,
} from "./lib/harness.ts";

/**
 * `pnpm test:server-component-defer`: Server Components + Angular `@defer` /
 * incremental hydration (docs/research/server-component-defer-poc.md),
 * against the Analog fixture's production build on Nitro `node-server`.
 *
 *   1. production build; bundle evidence (deferred widgets only in chunks
 *      reached by dynamic import) and graph scans
 *   2. HTTP SSR: island roots with protocol v1, deferred main content
 *      rendered and dehydrated
 *   3. Chromium: Strata hydrates the island roots; Angular hydrates each
 *      deferred subtree on its own trigger (interaction with event replay,
 *      viewport), lazy chunk requested only then, DOM reused
 *   4. protocol v1 still gates the island that owns the defer block
 *   5. fail closed: `@defer` in a server-owned template fails the build
 */

const TITLE = "Server Components + Angular @defer";
const stop = (): never => finish(TITLE);

section("Production build");
build("defer fixture", {}, stop);

const bundle = checkDeferBundle();
const graphs = checkDeferGraphs(
  dirGraph("dist/client, dist/analog/public", BROWSER_DIRS),
  dirGraph("dist/ssr, dist/analog/server", SERVER_DIRS),
);

const server = await startProductionServer();
let ssr: boolean | undefined;
let browser: Awaited<ReturnType<typeof checkDeferBrowser>> | undefined;

try {
  ssr = await checkDeferSsr(server.baseUrl, "Production server");
  browser = await checkDeferBrowser(server.baseUrl, {
    runtime: "Production server",
    protocolGate: true,
  });

  section("Production server log");

  const serverErrors = server.output().match(/^.*\b(?:ERROR|Error)\b.*$/gm) ?? [];

  check("no server error while rendering", serverErrors.length === 0, serverErrors.join(" | "));
} finally {
  await server.stop();
}

const failsClosed = checkDeferFailsClosed();

section("Classification (as measured)");

const go = (ok: boolean | undefined) => (ok ? "GO" : "NO-GO");

console.log(`bundle: deferred code in lazy chunks only     ${go(bundle && graphs)}`);
console.log(`SSR: deferred main content, dehydrated        ${go(ssr)}`);
console.log(`Layer 1: Strata hydrates island roots         ${go(browser?.layer1)}`);
console.log(`Layer 2: hydrate on interaction + replay      ${go(browser?.interaction)}`);
console.log(`Layer 2: hydrate on viewport                  ${go(browser?.viewport)}`);
console.log(`no hydration/console errors, no server leak   ${go(browser?.clean)}`);
console.log(`protocol v1 gates the deferred island         ${go(browser?.protocolGate)}`);
console.log(`server-owned @defer fails the build           ${go(failsClosed)}`);

stop();
