import type { ArmId, ArmSpec, IslandCount } from "./arms.ts";

/**
 * What each arm MUST and MUST NOT contain, and the correctness rules a build has to
 * satisfy before any of its numbers may enter a comparison table. A build or
 * confidentiality failure is a failed arm, never a smaller bundle.
 */

export const MARKERS = {
  /** In the browser of every arm: the hydrated island. A missing one means broken client code. */
  client: "PERF_CONSUMER_CLIENT_MARKER",
  /** Server-owned in the Server Component arms; ordinary browser code in the plain arms. */
  implementation: "PERF_CONSUMER_IMPLEMENTATION_MARKER",
  server: "PERF_CONSUMER_SERVER_MARKER",
  transitive: "PERF_CONSUMER_TRANSITIVE_MARKER",
  privateNote: "PERF_PRIVATE_SUPPLIER_CANARY_9f3c",
  privateCost: "7391047",
  controller: "PERF_CONTROLLER_MARKER",
  native: "PERF_NATIVE_HANDLER_MARKER",
  /** Three-island profile only: the second and third client islands. */
  stockClient: "PERF_STOCK_CLIENT_MARKER",
  deliveryClient: "PERF_DELIVERY_CLIENT_MARKER",
  /** Three-island profile only: server-owned in the Server Component arms. */
  fulfilmentServer: "PERF_FULFILMENT_SERVER_MARKER",
  privateWarehouse: "PERF_PRIVATE_WAREHOUSE_CANARY_5b1d",
} as const;

/** Values owned by the page's server graph (the Server Component arms must hide them). */
export const PAGE_SERVER_MARKERS = [
  MARKERS.implementation,
  MARKERS.server,
  MARKERS.transitive,
  MARKERS.privateNote,
  MARKERS.privateCost,
] as const;

/** The SSR page's `data-evidence`, computed from the same constants as the fixture. */
export const fingerprint = (value: string): string => {
  let result = 0;

  for (let index = 0; index < value.length; index++) {
    result = (Math.imul(result, 31) + value.charCodeAt(index)) | 0;
  }

  return (result >>> 0).toString(16);
};

/** Markers added to the page's server graph by the three-island profile. */
export const FULFILMENT_SERVER_MARKERS = [
  MARKERS.fulfilmentServer,
  MARKERS.privateWarehouse,
] as const;

/** Markers of the browser islands, per profile (one for `1`, three for `3`). */
export const clientMarkersFor = (islands: IslandCount): readonly string[] =>
  islands === 1 ? [MARKERS.client] : [MARKERS.client, MARKERS.stockClient, MARKERS.deliveryClient];

export const EXPECTED_EVIDENCE = [
  fingerprint(MARKERS.implementation),
  fingerprint(MARKERS.server),
  fingerprint(MARKERS.transitive),
  fingerprint(MARKERS.privateNote),
].join(".");

export const EXPECTED_FULFILMENT_EVIDENCE = [
  fingerprint(MARKERS.fulfilmentServer),
  fingerprint(MARKERS.privateWarehouse),
].join(".");

export const PRODUCT_42 = { id: "42", name: "Product 42", available: true } as const;

// ---------------------------------------------------------------------------
// Marker expectations

export type Where = "server" | "browser";

export interface Expectation {
  readonly marker: string;
  readonly where: Where;
  readonly present: boolean;
  readonly reason: string;
}

/** The marker matrix of one arm: presence in the server graph and in the browser output. */
export function expectationsFor(arm: ArmSpec, islands: IslandCount = 1): Expectation[] {
  const serverComponent = arm.page === "server-component";
  const controller = arm.api === "controller";
  const out: Expectation[] = clientMarkersFor(islands).map((marker) => ({
    marker,
    where: "browser" as const,
    present: true,
    reason: "the hydrated island must reach the browser (positive control)",
  }));
  const pageServerMarkers =
    islands === 1 ? PAGE_SERVER_MARKERS : [...PAGE_SERVER_MARKERS, ...FULFILMENT_SERVER_MARKERS];

  for (const marker of pageServerMarkers) {
    out.push({
      marker,
      where: "server",
      present: true,
      reason: "the page implementation must be in the server graph",
    });
    out.push({
      marker,
      where: "browser",
      present: !serverComponent,
      reason: serverComponent
        ? "Server Component graph must stay out of the browser"
        : "an ordinary Angular component is a browser graph (positive control for the scanner)",
    });
  }

  out.push(
    {
      marker: controller ? MARKERS.controller : MARKERS.native,
      where: "server",
      present: true,
      reason: "the API handler of this arm must be in the server graph",
    },
    {
      marker: controller ? MARKERS.native : MARKERS.controller,
      where: "server",
      present: false,
      reason: "the other arm's API handler must not be present",
    },
    {
      marker: MARKERS.controller,
      where: "browser",
      present: false,
      reason: "controllers are server-only",
    },
    {
      marker: MARKERS.native,
      where: "browser",
      present: false,
      reason: "the Nitro handler is server-only",
    },
  );

  return out;
}

export interface Scan {
  /** Files (relative) in which each marker was found, per side. */
  readonly server: Readonly<Record<string, readonly string[]>>;
  readonly browser: Readonly<Record<string, readonly string[]>>;
}

/** The expectations a scan violates; empty means the confidentiality contract holds. */
export function confidentialityProblems(
  arm: ArmSpec,
  scan: Scan,
  islands: IslandCount = 1,
): string[] {
  return expectationsFor(arm, islands).flatMap((e) => {
    const found = (e.where === "server" ? scan.server : scan.browser)[e.marker]?.length ?? 0;

    return found > 0 === e.present
      ? []
      : [
          `${e.marker} ${e.present ? "missing from" : "found in"} the ${e.where} output (${e.reason})`,
        ];
  });
}

// ---------------------------------------------------------------------------
// Strata isolation of the native baseline

const STRATA_SPECIFIER = /["'`]@strata-sc\/[^"'`\s]+["'`]/g;

export const strataSpecifiersIn = (source: string): string[] => [
  ...new Set(source.match(STRATA_SPECIFIER) ?? []),
];

export interface IsolationInput {
  readonly manifestDependencies: Readonly<Record<string, string>>;
  readonly sources: Readonly<Record<string, string>>;
  readonly lockKeys: readonly string[];
  readonly installedScopes: readonly string[];
  /** Text of every built server and browser file, by path. */
  readonly built: Readonly<Record<string, string>>;
}

/** Everything that proves no Strata package exists anywhere in a baseline arm. */
export function baselineIsolationProblems(input: IsolationInput): string[] {
  const problems: string[] = [];
  const declared = Object.keys(input.manifestDependencies).filter((name) =>
    name.startsWith("@strata-sc/"),
  );

  if (declared.length > 0) problems.push(`manifest declares ${declared.join(", ")}`);

  for (const [file, source] of Object.entries(input.sources)) {
    const found = strataSpecifiersIn(source);

    if (found.length > 0) problems.push(`${file} imports ${found.join(", ")}`);
  }

  const locked = input.lockKeys.filter((key) => key.includes("@strata-sc/"));

  if (locked.length > 0) problems.push(`lockfile resolves ${locked.join(", ")}`);
  if (input.installedScopes.includes("@strata-sc")) problems.push("node_modules/@strata-sc exists");

  for (const [file, text] of Object.entries(input.built)) {
    if (text.includes("@strata-sc/")) problems.push(`built output ${file} references @strata-sc/`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Dependency tuple

export interface LockEntry {
  readonly version?: string;
  readonly integrity?: string;
}

/** name path → `version integrity` for every locked package that is not a Strata tarball. */
export function lockTuple(packages: Readonly<Record<string, LockEntry>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(packages)
      .filter(([key]) => key !== "" && !key.includes("@strata-sc/"))
      .map(([key, entry]) => [key, `${entry.version ?? "?"} ${entry.integrity ?? "-"}`]),
  );
}

/** Differences between the arms' tuples; an arm may never be compared on another tuple. */
export function tupleMismatches(
  tuples: Readonly<Partial<Record<ArmId, Readonly<Record<string, string>>>>>,
): string[] {
  const arms = Object.keys(tuples) as ArmId[];
  const [first, ...rest] = arms;

  if (first === undefined) return ["no dependency tuple recorded"];

  const reference = tuples[first]!;
  const problems: string[] = [];

  for (const arm of rest) {
    const other = tuples[arm]!;

    for (const key of new Set([...Object.keys(reference), ...Object.keys(other)])) {
      if (reference[key] !== other[key])
        problems.push(
          `${key}: arm ${first} ${reference[key] ?? "(absent)"} vs arm ${arm} ${other[key] ?? "(absent)"}`,
        );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Response correctness

export interface HttpOutcome {
  readonly status: number;
  readonly body: string;
}

/** The public JSON contract: `GET /api/products/42` is exactly Product 42, available. */
export function apiProblems({ status, body }: HttpOutcome): string[] {
  if (status !== 200) return [`status ${status}`];

  try {
    const json = JSON.parse(body) as Record<string, unknown>;

    return json["id"] === PRODUCT_42.id &&
      json["name"] === PRODUCT_42.name &&
      json["available"] === PRODUCT_42.available &&
      Object.keys(json).length === 3
      ? []
      : [`unexpected JSON ${body.slice(0, 120)}`];
  } catch {
    return ["body is not JSON"];
  }
}

/** The SSR document: title, product heading, server-computed tier, evidence and the island. */
export function ssrProblems({ status, body }: HttpOutcome, islands: IslandCount = 1): string[] {
  const problems: string[] = [];

  if (status !== 200) problems.push(`status ${status}`);
  if (!body.includes("<title>Strata performance baseline</title>")) problems.push("title");
  if (!/<h1[^>]*>Product 42<\/h1>/.test(body)) problems.push("product heading");
  if (!/id="server-tier"[^>]*>Tier: premium</.test(body)) problems.push("server-computed tier");
  if (!body.includes(`data-evidence="${EXPECTED_EVIDENCE}"`)) problems.push("server evidence");
  if (!/<button[^>]*data-product-id="42"/.test(body)) problems.push("island button");
  if (!body.includes("Availability: not checked")) problems.push("island initial state");
  if (islands > 1) problems.push(...threeIslandSsrProblems(body));

  return problems;
}

/** Strata's own boundary markup must never appear in a plain-Angular arm's HTML. */
export const hasStrataBoundary = (body: string): boolean => /data-strata/.test(body);

// ---------------------------------------------------------------------------
// Strata packages inside the browser graph

/** `@strata-sc/*` packages the browser may legitimately contain: only the island runtime. */
export function allowedBrowserStrata(arm: ArmSpec): readonly string[] {
  return arm.page === "server-component" ? ["@strata-sc/server-components"] : [];
}

/** Strata packages named by the browser source maps that this arm must not ship. */
export function browserStrataProblems(
  arm: ArmSpec,
  packagesInBrowser: readonly string[],
): string[] {
  const allowed = allowedBrowserStrata(arm);

  return packagesInBrowser
    .filter((name) => name.startsWith("@strata-sc/") && !allowed.includes(name))
    .map((name) => `${name} is in the browser source maps of arm ${arm.id}`);
}

// ---------------------------------------------------------------------------
// The island dimension (one interactive island, or three distinct ones)

export interface IslandSpec {
  readonly id: "availability" | "stock" | "delivery";
  /** The island's own component selector: its identity in the DOM. */
  readonly selector: string;
  readonly clientMarker: string;
  /** The one public API request its click issues, for product 42. */
  readonly apiPath: string;
  readonly initial: string;
  readonly afterClick: string;
  readonly apiBody: Readonly<Record<string, string | number | boolean>>;
}

const ALL_ISLANDS: readonly IslandSpec[] = [
  {
    id: "availability",
    selector: "product-availability",
    clientMarker: MARKERS.client,
    apiPath: "/api/products/42",
    initial: "Availability: not checked",
    afterClick: "Availability: available",
    apiBody: PRODUCT_42,
  },
  {
    id: "stock",
    selector: "product-stock",
    clientMarker: MARKERS.stockClient,
    apiPath: "/api/products/42/stock",
    initial: "Stock: not checked",
    afterClick: "Stock: 12 units",
    apiBody: { id: "42", units: 12 },
  },
  {
    id: "delivery",
    selector: "product-delivery",
    clientMarker: MARKERS.deliveryClient,
    apiPath: "/api/products/42/delivery",
    initial: "Delivery: not estimated",
    afterClick: "Delivery: 3 days",
    apiBody: { id: "42", days: 3 },
  },
];

export const islandsFor = (count: IslandCount): readonly IslandSpec[] =>
  ALL_ISLANDS.slice(0, count);

/** An API body is exactly the island's public JSON object (no extra, no missing key). */
export function exactJsonProblems(
  { status, body }: HttpOutcome,
  expected: Readonly<Record<string, string | number | boolean>>,
): string[] {
  if (status !== 200) return [`status ${status}`];

  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const keys = Object.keys(expected);

    return keys.length === Object.keys(json).length &&
      keys.every((key) => json[key] === expected[key])
      ? []
      : [`unexpected JSON ${body.slice(0, 120)}`];
  } catch {
    return ["body is not JSON"];
  }
}

const countOf = (body: string, pattern: RegExp): number => body.match(pattern)?.length ?? 0;

/** What the three-island SSR document must add to the one-island assertions. */
function threeIslandSsrProblems(body: string): string[] {
  const problems: string[] = [];

  for (const island of islandsFor(3)) {
    if (countOf(body, new RegExp(`<${island.selector}[\\s>]`, "g")) !== 1)
      problems.push(`${island.selector} is not rendered exactly once`);
    if (!body.includes(island.initial)) problems.push(`${island.id} initial state`);
  }

  if (countOf(body, /<button[^>]*data-product-id="42"/g) !== 3)
    problems.push("three island buttons");
  if (!/id="ship-from"[^>]*>Ships from: EU-South</.test(body))
    problems.push("server-chosen region");
  if (!body.includes(`data-fulfilment="${EXPECTED_FULFILMENT_EVIDENCE}"`))
    problems.push("fulfilment server evidence");

  return problems;
}

/** Private values that must never be visible anywhere a client can look. */
export const PRIVATE_CANARIES = [
  MARKERS.privateNote,
  MARKERS.privateCost,
  MARKERS.privateWarehouse,
] as const;

/** Canaries visible in a document, a response body or a serialized prop; empty means none. */
export const canariesIn = (text: string): string[] =>
  PRIVATE_CANARIES.filter((canary) => text.includes(canary));

const BOUNDARY_CLIENT = /data-strata-client="([^"]*)"/g;
const BOUNDARY_PROPS = /data-strata-props="([^"]*)"/g;

/** The island selectors named by Strata's boundary markup, in document order. */
export const boundaryIdentities = (body: string): string[] =>
  [...body.matchAll(BOUNDARY_CLIENT)].map((match) => match[1] ?? "");

/** Serialized boundary props as written in the HTML (still entity-escaped). */
export const boundaryProps = (body: string): string[] =>
  [...body.matchAll(BOUNDARY_PROPS)].map((match) => match[1] ?? "");

/**
 * Boundary markup of the SSR document. Server Component arms have exactly one boundary per island,
 * each naming a distinct island selector; plain arms have none. Props carry nothing private.
 */
export function boundaryProblems(body: string, serverComponent: boolean, islands: IslandCount) {
  const identities = boundaryIdentities(body);
  const problems: string[] = [];

  if (!serverComponent) {
    if (identities.length > 0 || hasStrataBoundary(body))
      problems.push("unexpected Strata boundary");

    return problems;
  }

  const expected = islandsFor(islands).map((island) => island.selector);

  if (identities.length !== expected.length)
    problems.push(`${identities.length} boundaries, expected ${expected.length}`);
  if (new Set(identities).size !== identities.length)
    problems.push(`duplicate boundary identity: ${identities.join(", ")}`);
  for (const selector of expected)
    if (!identities.includes(selector)) problems.push(`no boundary for ${selector}`);
  for (const props of boundaryProps(body))
    if (canariesIn(props).length > 0) problems.push("a private canary is in a boundary's props");
  if (boundaryProps(body).length !== expected.length)
    problems.push(
      `${boundaryProps(body).length} serialized prop sets, expected ${expected.length}`,
    );

  return problems;
}

/** Everything wrong in one HTML/API body with respect to private canaries. */
export const canaryProblems = (label: string, text: string): string[] =>
  canariesIn(text).map((canary) => `${label} exposes ${canary}`);

// ---------------------------------------------------------------------------
// Browser observations of the islands (produced by the smoke, judged here)

export interface IslandObservation {
  readonly id: IslandSpec["id"];
  /** Elements matching the island's selector after hydration (must be exactly one). */
  readonly count: number;
  /** The SSR button, output and text node were the very nodes in the hydrated DOM. */
  readonly reused: boolean;
  /** Status text before any interaction. */
  readonly before: string;
  /** Status text of every island right after THIS island's click settled. */
  readonly statusesAfterClick: Readonly<Record<string, string>>;
  /** Public API requests whose URL ended with this island's `apiPath`. */
  readonly requests: number;
}

/** Judges the observations of every island; empty means hydration and interaction are correct. */
export function islandInteractionProblems(
  specs: readonly IslandSpec[],
  observations: readonly IslandObservation[],
): string[] {
  const problems: string[] = [];

  for (const spec of specs) {
    const seen = observations.filter((o) => o.id === spec.id);

    if (seen.length === 0) {
      problems.push(`${spec.id}: island missing from the page`);
      continue;
    }

    const o = seen[0]!;

    if (seen.length > 1) problems.push(`${spec.id}: observed more than once`);
    if (o.count === 0) problems.push(`${spec.id}: island missing from the page`);
    if (o.count > 1) problems.push(`${spec.id}: duplicate island (${o.count} elements)`);
    if (!o.reused) problems.push(`${spec.id}: hydration did not reuse the SSR nodes`);
    if (o.before !== spec.initial) problems.push(`${spec.id}: initial state "${o.before}"`);
    if (o.requests !== 1)
      problems.push(`${spec.id}: ${o.requests} API request(s), expected exactly 1`);

    for (const other of specs) {
      const status = o.statusesAfterClick[other.id];
      const expected =
        specs.indexOf(other) <= specs.indexOf(spec) ? other.afterClick : other.initial;

      if (status !== expected)
        problems.push(
          `${spec.id} click: ${other.id} shows "${status ?? "(missing)"}", expected "${expected}"`,
        );
    }
  }

  return problems;
}
