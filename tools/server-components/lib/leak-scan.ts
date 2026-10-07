import { check, graphFilesWith } from "./harness.ts";
import type { OutputGraph } from "./harness.ts";

/**
 * The reusable canary scanner of the server-component qualification: one
 * place that says what "this canary is (not) on that surface" means, over
 * text (HTML, headers, DOM, network bodies, logs) and over build graphs
 * (delegating to `graphFilesWith`, the scan every other gate uses).
 * `pnpm test:server-component-security` is its first user; a future security
 * test passes its own canary and surfaces. Not a package, not public API.
 *
 * A canary is matched in its raw form and in the encodings a serializer,
 * template or transport could silently apply (base64, hex, percent and
 * HTML/JS escapes, reversed), and by its family prefix and unique suffix,
 * so a truncated or re-encoded leak is still a leak.
 */

export interface Canary {
  /** Name printed in checks. */
  readonly label: string;
  readonly value: string;
  /** The shared prefix of every canary of this kind: `STRATA_DATA_SECRET_CANARY`. */
  readonly family: string;
}

/** A synthetic server-owned DATA secret: no public surface may ever carry it. */
export const DATA_SECRET_CANARY: Canary = {
  label: "DATA_SECRET_CANARY",
  value: "STRATA_DATA_SECRET_CANARY_8E41B7D2A6F9",
  family: "STRATA_DATA_SECRET_CANARY",
};

/**
 * A value passed on purpose through `[strataClient]`: public browser data. It
 * is the positive control: it MUST be found on every surface it crosses, or a
 * clean DATA scan could be a scanner that sees nothing.
 */
export const PUBLIC_CONTROL_CANARY: Canary = {
  label: "PUBLIC_CONTROL_CANARY",
  value: "STRATA_PUBLIC_CONTROL_CANARY_3C95E0A7D184",
  family: "STRATA_PUBLIC_CONTROL_CANARY",
};

export interface Variant {
  readonly name: string;
  readonly needle: string;
}

/** Base64 of `value` at each of the three byte alignments, without padding-affected characters. */
function base64Variants(value: string): Variant[] {
  const bytes = Buffer.from(value, "utf8");

  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes])
      .toString("base64")
      .replace(/=+$/, "");
    const skip = [0, 2, 3][offset] ?? 0;
    const remainder = (bytes.length + offset) % 3;
    const tail = remainder === 0 ? 0 : remainder === 1 ? 2 : 1;

    return { name: `base64+${offset}`, needle: encoded.slice(skip, encoded.length - tail) };
  });
}

/** Every form of the canary the scan looks for. The first is the raw value. */
export function variantsOf(canary: Canary): Variant[] {
  const { value, family } = canary;
  const codePoints = [...value].map((char) => char.codePointAt(0) ?? 0);

  return [
    { name: "raw", needle: value },
    { name: "family prefix", needle: family },
    { name: "unique suffix", needle: value.slice(family.length + 1) },
    { name: "lower-case", needle: value.toLowerCase() },
    { name: "reversed", needle: [...value].reverse().join("") },
    ...base64Variants(value),
    { name: "hex", needle: Buffer.from(value, "utf8").toString("hex") },
    { name: "HEX", needle: Buffer.from(value, "utf8").toString("hex").toUpperCase() },
    { name: "percent-encoded", needle: codePoints.map((c) => `%${c.toString(16)}`).join("") },
    { name: "HTML decimal entities", needle: codePoints.map((c) => `&#${c};`).join("") },
    { name: "HTML hex entities", needle: codePoints.map((c) => `&#x${c.toString(16)};`).join("") },
    {
      name: "JS \\u escapes",
      needle: codePoints.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join(""),
    },
  ].filter((variant) => variant.needle.length > 0);
}

/** The forms of `canary` found in `text`, by name. */
export function leaksIn(canary: Canary, text: string): string[] {
  return variantsOf(canary)
    .filter((variant) => text.includes(variant.needle))
    .map((variant) => variant.name);
}

/**
 * The scanner's own control: each encoding it claims to see, embedded in
 * unrelated bytes, is found; the sibling PUBLIC canary and clean text are not.
 * A scan that cannot pass this proves nothing when it reports nothing.
 */
export function scannerSelfTest(canary: Canary = DATA_SECRET_CANARY): boolean {
  const { value, family } = canary;
  const bytes = Buffer.from(value, "utf8");
  const points = [...value].map((char) => char.codePointAt(0) ?? 0);
  const context = (text: string): string => `lorem ipsum ${text} dolor sit amet`;
  const samples: readonly (readonly [string, string])[] = [
    ["raw", value],
    ["family prefix only (truncated)", `${family}_`],
    ["unique suffix only", value.slice(family.length + 1)],
    ["lower-case", value.toLowerCase()],
    ["reversed", [...value].reverse().join("")],
    ...[0, 1, 2].map((pad): readonly [string, string] => [
      `base64 at alignment ${pad}`,
      Buffer.concat([Buffer.from("x".repeat(pad)), bytes, Buffer.from("tail")]).toString("base64"),
    ]),
    ["hex", bytes.toString("hex")],
    ["percent-encoded", points.map((c) => `%${c.toString(16)}`).join("")],
    ["HTML decimal entities", points.map((c) => `&#${c};`).join("")],
    ["JS \\u escapes", points.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join("")],
  ];
  const misses = samples.filter(([, text]) => leaksIn(canary, context(text)).length === 0);
  const sibling = canary === DATA_SECRET_CANARY ? PUBLIC_CONTROL_CANARY : DATA_SECRET_CANARY;

  return [
    check(
      `scanner control: ${samples.length} encodings of ${canary.label} are all found`,
      misses.length === 0,
      `missed: ${misses.map(([name]) => name).join(", ")}`,
    ),
    check(
      `scanner control: ${sibling.label} and clean text are not reported as ${canary.label}`,
      leaksIn(canary, context(sibling.value)).length === 0 &&
        leaksIn(canary, "no secrets here: <html><body>Internal verification: ready</body></html>")
          .length === 0,
    ),
  ].every(Boolean);
}

const found = (names: readonly string[]): string => `found as: ${names.join(", ")}`;

/** `surface` (an HTTP body, header block, DOM dump, log slice) carries none of the canary's forms. */
export function expectAbsent(surface: string, canary: Canary, text: string): boolean {
  const names = leaksIn(canary, text);

  return check(`${canary.label} ✗ ${surface}`, names.length === 0, found(names));
}

/** `surface` carries the canary's raw value (positive control). */
export function expectPresent(surface: string, canary: Canary, text: string): boolean {
  return check(`${canary.label} ✓ ${surface}`, text.includes(canary.value), "not found");
}

/** Files of `graph` carrying any form of the canary: file → forms. */
export function graphLeaks(canary: Canary, graph: OutputGraph): Map<string, string[]> {
  const leaks = new Map<string, string[]>();

  for (const { name, needle } of variantsOf(canary)) {
    for (const file of graphFilesWith(graph, needle)) {
      leaks.set(file, [...(leaks.get(file) ?? []), name]);
    }
  }

  return leaks;
}

const describeLeaks = (leaks: ReadonlyMap<string, readonly string[]>): string =>
  [...leaks].map(([file, forms]) => `${file} (${forms.join(", ")})`).join("; ");

/** No file of `graph` carries any form of the canary. */
export function expectGraphAbsent(canary: Canary, graph: OutputGraph): boolean {
  const leaks = graphLeaks(canary, graph);

  return check(
    `${canary.label} ✗ every file of ${graph.label} (${graph.files.length} files)`,
    leaks.size === 0,
    describeLeaks(leaks),
  );
}

/** At least one file of `graph` carries the canary's raw value (positive control). */
export function expectGraphPresent(canary: Canary, graph: OutputGraph): boolean {
  const files = graphFilesWith(graph, canary.value);

  return check(
    `${canary.label} ✓ ${graph.label} (${files.slice(0, 4).join(", ")}${files.length > 4 ? ", …" : ""})`,
    files.length > 0,
    "not found",
  );
}

/** File counts by extension, to show what a graph scan actually covered. */
export function extensionCounts(graph: OutputGraph): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const file of graph.files) {
    const extension = /\.[^./]+$/.exec(file)?.[0] ?? "(none)";

    counts[extension] = (counts[extension] ?? 0) + 1;
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// HTTP surfaces

export interface CapturedResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  /** Every response header, `set-cookie` included, as `name: value` lines. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** One GET, redirects not followed, with the status, every header and the whole body. */
export async function captureResponse(url: string, timeoutMs = 30_000): Promise<CapturedResponse> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const headers: [string, string][] = [...response.headers.entries()].filter(
    ([name]) => name !== "set-cookie",
  );

  for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);

  return {
    url,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    headers,
    body: await response.text(),
  };
}

export const headerBlock = (response: CapturedResponse): string =>
  response.headers.map(([name, value]) => `${name}: ${value}`).join("\n");

/** `status`, content type, header names and body size, for the evidence log. */
export function summarize(response: CapturedResponse): string {
  return (
    `HTTP ${response.status} ${response.statusText}; content-type ${response.contentType ?? "(none)"}; ` +
    `headers [${response.headers.map(([name]) => name).join(", ")}]; body ${response.body.length} chars`
  );
}

/** The canary is on neither the headers nor the body of `response`. */
export function expectResponseAbsent(
  surface: string,
  canary: Canary,
  response: CapturedResponse,
): boolean {
  return [
    expectAbsent(`${surface} response headers`, canary, headerBlock(response)),
    expectAbsent(`${surface} response body`, canary, response.body),
  ].every(Boolean);
}

/**
 * Server internals a public response must not show: stack frames, file
 * locations, the checkout's absolute path, bundler paths, and fragments of the
 * secret-bearing modules' source. Reasonable identifiers, not a proof of
 * absence of every possible disclosure.
 */
export function internalsIn(text: string, roots: readonly string[]): string[] {
  const probes: readonly (readonly [string, boolean])[] = [
    ["stack frame (`at x (file:line)`)", /\n\s+at [^\n]*(?:\(|file:|\.m?js:\d+)/.test(text)],
    ["file:// URL", text.includes("file://")],
    ["source location (.ts/.mjs/.js:line)", /\.(?:m?js|ts):\d+(?::\d+)?/.test(text)],
    ["node_modules path", text.includes("node_modules")],
    ["bundle chunk path (chunks/)", /\bchunks\//.test(text)],
    ["secret module name", /security-(?:secret|repository)/.test(text)],
    ["repository method name", /failInternally|verifyInternalConfiguration/.test(text)],
    [
      "secret module source (Math.imul / digest)",
      /Math\.imul\(hash \^|EXPECTED_CREDENTIAL_DIGEST/.test(text),
    ],
    ["expected credential digest", text.includes("80d39693")],
    ...roots.map((root): readonly [string, boolean] => [
      `absolute path ${root}`,
      text.includes(root),
    ]),
  ];

  return probes.filter(([, present]) => present).map(([name]) => name);
}

export function expectNoInternals(
  surface: string,
  text: string,
  roots: readonly string[],
): boolean {
  const names = internalsIn(text, roots);

  return check(
    `no server stack, source or sensitive path in ${surface}`,
    names.length === 0,
    names.join("; "),
  );
}

/** Decoded `<!-- … -->` comments, inline `<script>` bodies and Angular's serialized state of raw HTML. */
export function htmlRegions(html: string): {
  comments: string[];
  inlineScripts: string[];
  ngState: string;
  hydrationAnnotations: string[];
} {
  return {
    comments: html.match(/<!--[\s\S]*?-->/g) ?? [],
    inlineScripts: [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1] ?? "",
    ),
    ngState: html.match(/<script id="ng-state"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "",
    hydrationAnnotations: html.match(/\bngh="[^"]*"/g) ?? [],
  };
}
