import { httpGet } from "../analog/lib/process.ts";
import type { HttpResult } from "../analog/lib/process.ts";

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
const PRIVATE_VALUES = [
  "STRATA_REQUEST_PRIVATE_ALPHA_5B7C9D1E",
  "STRATA_REQUEST_PRIVATE_BETA_2F8A4C6D",
] as const;
const stop = (): never => finish(TITLE);
const rendered = (body: string, attribute: string, value: string): boolean =>
  new RegExp(`${attribute}[^>]*>${value}</`).test(body);

function responseFor(
  baseUrl: string,
  id: "alpha" | "beta",
  round: string,
  query = "",
): Promise<HttpResult> {
  return httpGet(`${baseUrl}${ROUTE}/${id}?round=${round}${query}`, 10_000);
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
  const responses = await Promise.all(ids.map((id) => responseFor(baseUrl, id, round)));
  const bodies = responses.map((response) => response.body);
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
      /data-request-context-service-instance[^>]*>shared<\/p>/.test(body) &&
      body.includes("client-ready 0") &&
      !body.includes(id === "alpha" ? "beta:verified" : "alpha:verified") &&
      PRIVATE_VALUES.every((value) => !body.includes(value))
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

async function adversarialRequests(baseUrl: string, runtime: string): Promise<boolean> {
  section(`${runtime}: rejected context and failure recovery`);
  const cases = [
    ["missing context", "/alpha?missing=true"],
    ["unknown identity", "/gamma"],
    ["malformed identity", "/%20alpha"],
    ["mismatched requested resource", "/alpha?resource=beta"],
  ] as const;
  const rejected = await Promise.all(
    cases.map(async ([label, path]) => ({
      label,
      response: await httpGet(`${baseUrl}${ROUTE}${path}`, 5_000),
    })),
  );
  const rejectedSafely = rejected.every(
    ({ response }) =>
      response.status === 200 &&
      !rendered(response.body, "data-request-context-parent", "alpha") &&
      !rendered(response.body, "data-request-context-parent", "beta") &&
      PRIVATE_VALUES.every((value) => !response.body.includes(value)),
  );
  for (const { label, response } of rejected) {
    check(
      `${label} fails closed with HTTP ${response.status} and empty safe render`,
      response.status === 200 &&
        !rendered(response.body, "data-request-context-parent", "alpha") &&
        !rendered(response.body, "data-request-context-parent", "beta"),
    );
  }
  check("invalid contexts never select another actor or expose private values", rejectedSafely);

  const failed = await responseFor(baseUrl, "alpha", `${runtime}-failure`, "&fail=true");
  check(
    "a failing repository operation is rejected without a safe success result",
    failed.status === 200 &&
      !failed.body.includes("alpha:verified") &&
      rendered(failed.body, "data-request-context-parent", "alpha"),
  );
  const recovered = await responseFor(baseUrl, "beta", `${runtime}-recovery`);
  return check(
    "a successful request immediately after failure is isolated",
    recovered.status === 200 &&
      rendered(recovered.body, "data-request-context-parent", "beta") &&
      rendered(recovered.body, "data-request-context-service", "beta:verified") &&
      !recovered.body.includes("alpha:verified"),
  );
}

async function sequentialRequests(baseUrl: string, runtime: string): Promise<boolean> {
  section(`${runtime}: sequential renders with fresh contexts`);
  const responses = [];
  for (const [index, id] of (["alpha", "beta", "alpha", "beta"] as const).entries()) {
    responses.push(await responseFor(baseUrl, id, `${runtime}-sequential-${index}`));
  }
  return check(
    "sequential renders do not inherit the previous private state",
    responses.every(
      (response, index) =>
        response.status === 200 &&
        rendered(
          response.body,
          "data-request-context-parent",
          index % 2 === 0 ? "alpha" : "beta",
        ) &&
        response.body.includes(`${index % 2 === 0 ? "alpha" : "beta"}:verified`),
    ),
  );
}

async function qualifyNode(): Promise<boolean> {
  section("Nitro node-server: overlapping SSR renders");
  const server = await startProductionServer();
  try {
    return (
      (await overlappingRound(server.baseUrl, "node-forward", false)) &&
      (await overlappingRound(server.baseUrl, "node-reverse", true)) &&
      (await sequentialRequests(server.baseUrl, "Node")) &&
      (await adversarialRequests(server.baseUrl, "Node"))
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
      (await overlappingRound(server.baseUrl, "workerd-reverse", true)) &&
      (await sequentialRequests(server.baseUrl, "workerd")) &&
      (await adversarialRequests(server.baseUrl, "workerd"))
    );
  } finally {
    await server.stop();
  }
}

build("Node", { BUILD_PRESET: undefined }, stop);
const browser = dirGraph("browser", BROWSER_DIRS);
check(
  "both private fixture values are absent from browser output",
  PRIVATE_VALUES.every((value) => graphFilesWith(browser, value).length === 0),
);
check(
  "both private fixture values are present in the server graph",
  PRIVATE_VALUES.every(
    (value) => graphFilesWith(dirGraph("server", ["analog/server"]), value).length > 0,
  ),
);
check(
  "request-context server module is present in SSR output",
  graphFilesWith(dirGraph("server", ["analog/server"]), "request-context").length > 0,
);
check("Node SSR isolates 24 overlapping requests in both orders", await qualifyNode());

build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, stop);
check("workerd isolates 24 overlapping requests in both orders", await qualifyWorkerd());

stop();
