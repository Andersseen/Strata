import { readFileSync } from "node:fs";
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
 *      island, interaction, mutation through a controller, the rollout
 *      island's own `@defer` (lazy chunk on first click, event replay), no
 *      Angular errors
 */

// Ordinary components server-owned through composition, their dependency,
// and a nested Server Component. Rendered only as hashes.
const CHILD = "RELAY_SERVER_ONLY_CHILD_MARKER_2B5E";
const GRANDCHILD = "RELAY_SERVER_ONLY_GRANDCHILD_MARKER_84F2";
const DEPENDENCY = "RELAY_SERVER_CHILD_DEPENDENCY_MARKER_C719";
const NESTED = "RELAY_NESTED_SERVER_COMPONENT_MARKER_E05D";

const SERVER_ONLY = [
  "RELAY_SERVER_ONLY_OPERATIONS_INTELLIGENCE_7C21",
  "RELAY_OPERATIONS_BRIEFING_SERVER_IMPLEMENTATION_4D18",
  "RELAY_RELEASE_GATE_SERVER_IMPLEMENTATION_1F37",
  "RELAY_INCIDENT_DIGEST_SERVER_IMPLEMENTATION_5B02",
  "RELAY_INCIDENT_DIGEST_SERVER_SOURCE_3E77",
  CHILD,
  GRANDCHILD,
  DEPENDENCY,
  NESTED,
];

/** The server components' 32-bit string hash (`fingerprint` in Relay). */
function fingerprint(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(16);
}

const appDir = join(repoRoot, "apps", "relay");
const generated = "src/generated/server-components/server-components";

const gate = createAppGate({
  title: "relay Server Component dogfood",
  appDir,
  baseUrlEnv: "STRATA_RELAY_BASE_URL",
  serverOnlyMarkers: SERVER_ONLY,
  clientMarkers: [
    "RELAY_BRIEFING_CLIENT_ISLAND_2A91",
    "RELAY_BRIEFING_WINDOW_CLIENT_ISLAND_68B4",
    "RELAY_ROLLOUT_CLIENT_ISLAND_91E3",
    "RELAY_INCIDENT_TRIAGE_CLIENT_ISLAND_A6C4",
    // Angular's own @defer inside the rollout island: a lazy browser chunk.
    "RELAY_ROLLOUT_WAVE_PLAN_DEFERRED_5C3A",
  ],
  serverModules: [
    "src/app/server-components/server-operations-intelligence.ts",
    "src/app/server-components/briefing/operations-briefing.server-component.ts",
    "src/app/server-components/release/release-gate.server-component.ts",
    "src/app/server-components/incidents/incident-digest.server-component.ts",
    "src/app/server-components/incidents/incident-digest.source.ts",
    // Reached only through the digest source: the controllers' own store.
    "src/server/strata/operations.repository.ts",
    // Ordinary Angular components, server-owned through composition only.
    "src/app/server-components/incidents/incident-list.component.ts",
    "src/app/server-components/incidents/incident-row.component.ts",
    // Injected only by the row, two levels below the Server Component.
    "src/app/server-components/incidents/incident-runbook.ts",
    // Nested in the briefing, and imported directly by the release page.
    "src/app/server-components/briefing/briefing-metadata.server-component.ts",
  ],
  clientModules: [
    "src/app/server-components/briefing/briefing-acknowledgement.component.ts",
    "src/app/server-components/briefing/briefing-window.component.ts",
    "src/app/server-components/release/rollout-simulator.component.ts",
    "src/app/server-components/release/rollout-wave-plan.component.ts",
    "src/app/server-components/incidents/incident-triage.component.ts",
    "src/generated/server-components/server-components/briefing/operations-briefing.server-component.ts",
    "src/generated/server-components/server-components/release/release-gate.server-component.ts",
    "src/generated/server-components/server-components/incidents/incident-digest.server-component.ts",
    "src/generated/server-components/server-components/briefing/briefing-metadata.server-component.ts",
  ],
  serverFileNames: [
    "intelligence",
    "server-component",
    "digest.source",
    "repository",
    "incident-list",
    "incident-row",
    "runbook",
  ],
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

  section(
    `${runtime}: GET / (prerendered) — operations briefing, nested Server Component, two islands`,
  );
  {
    const html = await page(baseUrl, "/");

    results.push(
      check(
        "briefing rendered by its Server Component",
        html.includes("Checkout traffic has stabilized"),
      ),
      check(
        "nested Server Component rendered inside the briefing (hash evidence)",
        /<relay-operations-briefing[\s\S]*<relay-briefing-metadata[^>]*>\s*<div[^>]*data-nested-server-evidence="([0-9a-f]+)"/.exec(
          html,
        )?.[1] === fingerprint(NESTED),
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

  section(
    `${runtime}: GET /release (runtime SSR) — release gate, and the nested Server Component imported directly`,
  );
  {
    const html = await page(baseUrl, "/release");

    results.push(
      check("assessment rendered by its Server Component", html.includes("Canary to 25%")),
      check(
        "BriefingMetadataServerComponent rendered on its own (hash evidence)",
        html.includes(`data-nested-server-evidence="${fingerprint(NESTED)}"`),
      ),
      check(
        "rollout and acknowledgement islands annotated with their server props",
        JSON.stringify(islands(html)) ===
          JSON.stringify([
            [
              "relay-rollout-simulator",
              { service: "Checkout API", version: "v2.19.0", maxPercent: 25, baselineRpm: 4800 },
            ],
            [
              "relay-briefing-acknowledgement",
              { alertId: "brief-eu-west-checkout", actionLabel: "Acknowledge briefing" },
            ],
          ]),
        JSON.stringify(islands(html)),
      ),
      check(
        "the island's @defer (hydrate on interaction) wave plan is server-rendered and dehydrated (ngb)",
        /<relay-rollout-wave-plan [^>]*\bngb="d\d+"/.test(html) &&
          html.includes("25% · 1200 req/min") &&
          !html.includes("Show wave plan"),
        html.match(/<relay-rollout-wave-plan[^>]*>/)?.[0] ?? "no <relay-rollout-wave-plan>",
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

    const items = afterCreate.match(/class="digest-item"/g)?.length ?? -1;
    const rows = afterCreate.match(
      new RegExp(`data-server-grandchild-evidence="${fingerprint(GRANDCHILD)}"`, "g"),
    );
    const newRow = new RegExp(`data-incident="${id}"[\\s\\S]*?data-runbook="([0-9a-f]+)"`).exec(
      afterCreate,
    );

    results.push(
      check(
        "the digest renders the incident the controller just created",
        afterCreate.includes(title),
      ),
      check(
        "IncidentListComponent (ordinary server child) rendered, once (hash evidence)",
        afterCreate.match(new RegExp(`data-server-child-evidence="${fingerprint(CHILD)}"`, "g"))
          ?.length === 1,
      ),
      check(
        `IncidentRowComponent (ordinary server grandchild) rendered once per incident (${rows?.length ?? 0}/${items})`,
        items > 0 && rows?.length === items,
      ),
      check(
        "the row's server-only runbook rendered the new critical incident's guidance",
        newRow?.[1] === fingerprint(`${DEPENDENCY}:critical`) &&
          afterCreate.includes("Runbook: Page the incident commander now"),
        newRow?.[1],
      ),
      check(
        "one triage island per active incident, the new one first with its props",
        triage.length === items &&
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

/**
 * The generated surrogates own every client reference found below them, and
 * import nothing else: no server child, no nested Server Component.
 */
function checkSurrogates(): void {
  section("Generated surrogates: transitive client references only");

  const imports = (surrogate: string): string[] =>
    (readFileSync(join(appDir, generated, surrogate), "utf8").match(/^import .*$/gm) ?? []).map(
      (line) => line.replace(/ from .*$/, ""),
    );
  const runtime = [
    "import { ChangeDetectionStrategy, Component }",
    "import { StrataIslandHost, provideClientReferences }",
  ];
  const expect = (surrogate: string, references: readonly string[]): boolean =>
    check(
      `${surrogate} imports ${references.join(", ")} and nothing server-owned`,
      JSON.stringify(imports(surrogate)) ===
        JSON.stringify([...runtime, ...references.map((name) => `import { ${name} }`)]),
      JSON.stringify(imports(surrogate)),
    );

  gate.verdict["surrogates own transitive client references"] = all([
    // Two levels of ordinary components between the digest and its island.
    expect("incidents/incident-digest.server-component.ts", ["IncidentTriageComponent"]),
    // The acknowledgement island is marked inside the nested Server Component.
    expect("briefing/operations-briefing.server-component.ts", [
      "BriefingAcknowledgementComponent",
      "BriefingWindowComponent",
    ]),
    // The nested Server Component keeps its own surrogate for direct use.
    expect("briefing/briefing-metadata.server-component.ts", ["BriefingAcknowledgementComponent"]),
  ]);
}

gate.control();
gate.nodeBuild();
checkSurrogates();
await gate.nodeServer(checkSsr);
gate.report();
