import { httpGet } from "../analog/lib/process.ts";

import {
  BROWSER_DIRS,
  build,
  check,
  dirGraph,
  finish,
  graphFilesWith,
  section,
  startProductionServer,
} from "./lib/harness.ts";
import { COMPATIBILITY_DATE, resolveWrangler, startWranglerPages } from "./lib/wrangler.ts";

const TITLE = "Server Component request context";
const ROUTE = "/server-component-request-context";
const CONFIDENTIAL = "request-context-confidential-alpha-beta";
const stop = (): never => finish(TITLE);

function responseFor(baseUrl: string, id: "alpha" | "beta", round: string): Promise<string> {
  return httpGet(`${baseUrl}${ROUTE}/${id}?round=${round}`).then((response) => response.body);
}

async function overlappingRound(
  baseUrl: string,
  round: string,
  reverse: boolean,
): Promise<boolean> {
  const ids: Array<"alpha" | "beta"> = Array.from({ length: 24 }, (_, index) => {
    const alpha = index % 2 === 0 ? "alpha" : "beta";
    return reverse ? (alpha === "alpha" ? "beta" : "alpha") : alpha;
  });
  const startedAt = performance.now();
  const bodies = await Promise.all(ids.map((id) => responseFor(baseUrl, id, round)));
  const elapsedMs = performance.now() - startedAt;

  const passed = bodies.every((body, index) => {
    const id = ids[index];
    const parent = new RegExp(`data-request-context-parent[^>]*>${id}</p>`);
    const child = new RegExp(`data-request-context-child[^>]*>${id}</p>`);
    const service = new RegExp(`data-request-context-service[^>]*>${id}:verified</p>`);
    return (
      parent.test(body) &&
      child.test(body) &&
      service.test(body) &&
      body.includes("client-ready 0") &&
      !body.includes(id === "alpha" ? "beta:verified" : "alpha:verified") &&
      !body.includes(CONFIDENTIAL)
    );
  });
  if (!passed) {
    console.log(
      `round ${round} failed; sample response:\n${bodies[0]?.slice(-2_000) ?? "(empty)"}`,
    );
  }
  if (elapsedMs >= 4_000) {
    console.log(`round ${round} took ${Math.round(elapsedMs)}ms; expected overlapping renders`);
    return false;
  }
  return passed;
}

async function qualifyNode(): Promise<boolean> {
  section("Nitro node-server: overlapping SSR renders");
  const server = await startProductionServer();
  try {
    const missing = await httpGet(`${server.baseUrl}${ROUTE}/alpha?missing=true`);
    check("missing context is safe and explicit", missing.body.includes(">missing</p>"));
    return (
      (await overlappingRound(server.baseUrl, "node-forward", false)) &&
      (await overlappingRound(server.baseUrl, "node-reverse", true))
    );
  } finally {
    await server.stop();
  }
}

async function qualifyWorkerd(): Promise<boolean> {
  section(`Cloudflare Pages local workerd (${COMPATIBILITY_DATE})`);
  const wrangler = resolveWrangler();
  const server = await startWranglerPages(wrangler);
  try {
    return (
      (await overlappingRound(server.baseUrl, "workerd-forward", false)) &&
      (await overlappingRound(server.baseUrl, "workerd-reverse", true))
    );
  } finally {
    await server.stop();
  }
}

build("Node", { BUILD_PRESET: undefined }, stop);
const browser = dirGraph("browser", BROWSER_DIRS);
check(
  "confidential fixture value is absent from browser output",
  graphFilesWith(browser, CONFIDENTIAL).length === 0,
);
check(
  "request-context server module is present in SSR output",
  graphFilesWith(dirGraph("server", ["analog/server"]), "request-context").length > 0,
);
check("Node SSR isolates 24 overlapping requests in both orders", await qualifyNode());

build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, stop);
check("workerd isolates 24 overlapping requests in both orders", await qualifyWorkerd());

stop();
