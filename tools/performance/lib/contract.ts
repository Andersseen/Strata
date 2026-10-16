import type { ArmId, ArmSpec } from "./arms.ts";

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

export const EXPECTED_EVIDENCE = [
  fingerprint(MARKERS.implementation),
  fingerprint(MARKERS.server),
  fingerprint(MARKERS.transitive),
  fingerprint(MARKERS.privateNote),
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
export function expectationsFor(arm: ArmSpec): Expectation[] {
  const serverComponent = arm.page === "server-component";
  const controller = arm.api === "controller";
  const out: Expectation[] = [
    {
      marker: MARKERS.client,
      where: "browser",
      present: true,
      reason: "the hydrated island must reach the browser (positive control)",
    },
  ];

  for (const marker of PAGE_SERVER_MARKERS) {
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
export function confidentialityProblems(arm: ArmSpec, scan: Scan): string[] {
  return expectationsFor(arm).flatMap((e) => {
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
export function ssrProblems({ status, body }: HttpOutcome): string[] {
  const problems: string[] = [];

  if (status !== 200) problems.push(`status ${status}`);
  if (!body.includes("<title>Strata performance baseline</title>")) problems.push("title");
  if (!/<h1[^>]*>Product 42<\/h1>/.test(body)) problems.push("product heading");
  if (!/id="server-tier"[^>]*>Tier: premium</.test(body)) problems.push("server-computed tier");
  if (!body.includes(`data-evidence="${EXPECTED_EVIDENCE}"`)) problems.push("server evidence");
  if (!/<button[^>]*data-product-id="42"/.test(body)) problems.push("island button");
  if (!body.includes("Availability: not checked")) problems.push("island initial state");

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
