import { join } from "node:path";

import { httpGet, httpRequest } from "../analog/lib/process.ts";

import { all, createAppGate } from "./lib/app-gate.ts";
import { check, repoRoot, section } from "./lib/harness.ts";

/**
 * `pnpm test:relay:server-components`: Relay, the operations console, uses
 * the private @strata-sc/server-components package the way a real app would:
 * three Server Components, five islands (two side by side, one per route,
 * one per incident inside `@for`), and one Server Component reading the same
 * in-memory repository the Strata controllers write to.
 *
 *   0. control build, plugin off: server-only code MUST leak
 *   1. Node build: browser graph (markers, bundled source modules, build
 *      tooling) and server graph
 *   2. Nitro node-server, HTTP only (HTML before any browser JavaScript):
 *      each route's Server Component and island annotations, then a
 *      controller write (POST, PATCH) the next server render must reflect
 *   3. Relay's Playwright suite against that server: hydration of every
 *      island, interaction, mutation through a controller, no Angular errors
 */

const SERVER_ONLY = [
  "RELAY_SERVER_ONLY_OPERATIONS_INTELLIGENCE_7C21",
  "RELAY_OPERATIONS_BRIEFING_SERVER_IMPLEMENTATION_4D18",
  "RELAY_RELEASE_GATE_SERVER_IMPLEMENTATION_1F37",
  "RELAY_INCIDENT_DIGEST_SERVER_IMPLEMENTATION_5B02",
  "RELAY_INCIDENT_DIGEST_SERVER_SOURCE_3E77",
];

const gate = createAppGate({
  title: "relay Server Component dogfood",
  appDir: join(repoRoot, "apps", "relay"),
  baseUrlEnv: "STRATA_RELAY_BASE_URL",
  serverOnlyMarkers: SERVER_ONLY,
  clientMarkers: [
    "RELAY_BRIEFING_CLIENT_ISLAND_2A91",
    "RELAY_BRIEFING_WINDOW_CLIENT_ISLAND_68B4",
    "RELAY_ROLLOUT_CLIENT_ISLAND_91E3",
    "RELAY_INCIDENT_TRIAGE_CLIENT_ISLAND_A6C4",
  ],
  serverModules: [
    "src/app/server-components/server-operations-intelligence.ts",
    "src/app/server-components/briefing/operations-briefing.server-component.ts",
    "src/app/server-components/release/release-gate.server-component.ts",
    "src/app/server-components/incidents/incident-digest.server-component.ts",
    "src/app/server-components/incidents/incident-digest.source.ts",
    // Reached only through the digest source: the controllers' own store.
    "src/server/strata/operations.repository.ts",
  ],
  clientModules: [
    "src/app/server-components/briefing/briefing-acknowledgement.component.ts",
    "src/app/server-components/briefing/briefing-window.component.ts",
    "src/app/server-components/release/rollout-simulator.component.ts",
    "src/app/server-components/incidents/incident-triage.component.ts",
    "src/generated/server-components/server-components/briefing/operations-briefing.server-component.ts",
    "src/generated/server-components/server-components/release/release-gate.server-component.ts",
    "src/generated/server-components/server-components/incidents/incident-digest.server-component.ts",
  ],
  serverFileNames: ["intelligence", "server-component", "digest.source", "repository"],
});

const decode = (value: string | undefined): unknown =>
  value === undefined ? undefined : JSON.parse(value.replaceAll("&quot;", '"'));

/** `[selector, props]` of every island boundary in `html`, in document order. */
function islands(html: string): [string, unknown][] {
  return [
    ...html.matchAll(
      /<([a-z-]+)\s[^>]*?data-strata-client="\1"[^>]*?\sdata-strata-props="([^"]*)"[^>]*?\sngh="\d+"[^>]*>/g,
    ),
  ].map((match) => [match[1]!, decode(match[2])]);
}

async function page(baseUrl: string, route: string): Promise<string> {
  const response = await httpGet(`${baseUrl}${route}`);

  check(
    `GET ${route}: HTTP 200 text/html`,
    response.status === 200 && !!response.contentType?.includes("text/html"),
    `${response.status} ${response.contentType}`,
  );

  return response.body;
}

async function checkSsr(baseUrl: string, runtime: string): Promise<boolean> {
  const results: boolean[] = [];
  const noMarkers = (route: string, html: string) =>
    check(
      `${route}: SSR HTML carries no server-only marker`,
      SERVER_ONLY.every((marker) => !html.includes(marker)),
    );

  section(`${runtime}: GET / (prerendered) — operations briefing, two islands`);
  {
    const html = await page(baseUrl, "/");

    results.push(
      check(
        "briefing rendered by its Server Component",
        html.includes("Checkout traffic has stabilized"),
      ),
      check(
        "both briefing islands annotated with their server props",
        JSON.stringify(islands(html)) ===
          JSON.stringify([
            [
              "relay-briefing-acknowledgement",
              { alertId: "brief-eu-west-checkout", actionLabel: "Acknowledge briefing" },
            ],
            ["relay-briefing-window", { initialWindow: 30, label: "Observation window" }],
          ]),
        JSON.stringify(islands(html)),
      ),
      noMarkers("/", html),
    );
  }

  section(`${runtime}: GET /release (runtime SSR) — release gate, one island`);
  {
    const html = await page(baseUrl, "/release");

    results.push(
      check("assessment rendered by its Server Component", html.includes("Canary to 25%")),
      check(
        "rollout island annotated with its server props",
        JSON.stringify(islands(html)) ===
          JSON.stringify([
            [
              "relay-rollout-simulator",
              { service: "Checkout API", version: "v2.19.0", maxPercent: 25, baselineRpm: 4800 },
            ],
          ]),
        JSON.stringify(islands(html)),
      ),
      noMarkers("/release", html),
    );
  }

  section(`${runtime}: controller writes, then GET /incidents renders them (shared server state)`);
  {
    const title = `Gate probe ${Date.now()}`;
    const created = await httpRequest(`${baseUrl}/api/ops/incidents`, {
      method: "POST",
      json: {
        title,
        serviceId: "checkout",
        environment: "production",
        severity: "critical",
        summary: "Written by a controller, read by a Server Component.",
      },
    });
    const id = (JSON.parse(created.body) as { incident?: { id?: string } }).incident?.id ?? "";

    results.push(check(`POST /api/ops/incidents → 200 (${id})`, created.status === 200 && !!id));

    const afterCreate = await page(baseUrl, "/incidents");
    const triage = islands(afterCreate).filter(
      ([selector]) => selector === "relay-incident-triage",
    );

    results.push(
      check(
        "the digest renders the incident the controller just created",
        afterCreate.includes(title),
      ),
      check(
        "one triage island per active incident, the new one first with its props",
        triage.length === (afterCreate.match(/class="digest-item"/g)?.length ?? -1) &&
          JSON.stringify(triage[0]?.[1]) ===
            JSON.stringify({ incidentId: id, initialStatus: "open" }),
        JSON.stringify(triage),
      ),
      noMarkers("/incidents", afterCreate),
    );

    const resolved = await httpRequest(`${baseUrl}/api/ops/incidents/${id}`, {
      method: "PATCH",
      json: { status: "resolved" },
    });
    const afterResolve = await page(baseUrl, "/incidents");

    results.push(
      check(`PATCH /api/ops/incidents/${id} → 200`, resolved.status === 200),
      check(
        "the next render no longer lists the resolved incident",
        !afterResolve.includes(title) && !afterResolve.includes(`data-incident="${id}"`),
      ),
    );
  }

  return all(results);
}

gate.control();
gate.nodeBuild();
await gate.nodeServer(checkSsr);
gate.report();
