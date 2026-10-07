import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

import { run } from "../../consumer/lib/exec.ts";

import { decodeAttribute } from "./boundaries.ts";
import { check, distDir, fixtureDir, repoRoot, section } from "./harness.ts";
import {
  DATA_SECRET_CANARY,
  PUBLIC_CONTROL_CANARY,
  captureResponse,
  expectAbsent,
  expectNoInternals,
  expectPresent,
  expectResponseAbsent,
  headerBlock,
  htmlRegions,
  internalsIn,
  leaksIn,
  summarize,
} from "./leak-scan.ts";
import type { CapturedResponse } from "./leak-scan.ts";

/**
 * Server Component DATA confidentiality (docs/research/server-component-data-security.md):
 * what the Analog fixture's `/server-component-security*` routes put on every
 * public surface, against whichever runtime serves them (Nitro `node-server`
 * or Wrangler's local Pages runtime). The scanner is lib/leak-scan.ts; the
 * build-graph scans reuse lib/server-only.ts. Two canaries:
 *
 *   DATA_SECRET_CANARY      read by a server-only repository: no public surface
 *   PUBLIC_CONTROL_CANARY   passed on purpose through `[strataClient]`: every
 *                           surface it crosses MUST show it (positive control)
 */

export const SECURITY_ROUTE = "/server-component-security";
export const FAILURE_MODES = ["plain", "cause", "aggregate"] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];
export const failureRoute = (mode: string): string => `/server-component-security-failure/${mode}`;
export const crossingRoute = (mode: "repository" | "nested"): string =>
  `/server-component-security-crossing/${mode}`;
export const requestRoute = (id: string): string => `/server-component-security-request/${id}`;

/** What each failure mode's server log must show, proving the error really was thrown. */
const FAILURE_LOG: Record<FailureMode, string> = {
  plain: `Synthetic server failure ${DATA_SECRET_CANARY.value}`,
  cause: "public wrapper",
  aggregate: "Synthetic aggregate failure",
};

export const SECURITY_MODULES = {
  secret: "src/app/server-component-security/security-secret.ts",
  repository: "src/app/server-component-security/security-repository.ts",
} as const;

const all = (results: readonly boolean[]): boolean => results.every(Boolean);

/** A running server under test. */
export interface RuntimeTarget {
  readonly name: string;
  readonly baseUrl: string;
  /** The server process's console output so far: the operator's surface, not the public one. */
  output(): string;
}

/** Window keys set by the fixture's test probes (`src/probes`), never by the runtime package. */
const FIXTURE_PROBES: ReadonlySet<string> = new Set([
  "__STRATA_ISLAND_PROBE__",
  "__STRATA_ROUTER_PROBE__",
]);

/** Absolute paths a public response must never print. */
const SENSITIVE_ROOTS = [...new Set([repoRoot, fixtureDir, homedir()])];

// ---------------------------------------------------------------------------
// Resolved framework tuple

/** The installed version of `name`, resolved from `from` (not the manifest's range). */
function installedVersion(name: string, from: string): string {
  const require = createRequire(join(from, "package.json"));

  for (const path of require.resolve.paths(name) ?? []) {
    const manifest = join(path, name, "package.json");

    if (existsSync(manifest)) {
      return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
    }
  }

  return "(not resolved)";
}

export interface FrameworkTuple {
  readonly rows: readonly (readonly [string, string])[];
}

/** The exact INSTALLED tuple the evidence of a run belongs to. */
export function resolvedFrameworkTuple(): FrameworkTuple {
  const platformDir = dirname(
    realpathSync(createRequire(join(fixtureDir, "package.json")).resolve("@analogjs/platform")),
  );
  const rows: [string, string][] = [
    ["node", process.version.replace(/^v/, "")],
    ...(
      [
        "@angular/core",
        "@angular/common",
        "@angular/compiler",
        "@angular/platform-browser",
        "@angular/platform-server",
        "@angular/router",
        "@analogjs/platform",
        "@analogjs/vite-plugin-angular",
      ] as const
    ).map((name): [string, string] => [name, installedVersion(name, fixtureDir)]),
    ["nitropack (resolved from @analogjs/platform)", installedVersion("nitropack", platformDir)],
    ["vite (fixture)", installedVersion("vite", fixtureDir)],
    ["typescript (fixture)", installedVersion("typescript", fixtureDir)],
    ["playwright", installedVersion("playwright", repoRoot)],
  ];

  return { rows };
}

export function printFrameworkTuple(): void {
  section("Resolved framework tuple (installed, from node_modules)");

  for (const [name, version] of resolvedFrameworkTuple().rows) console.log(`  ${name} ${version}`);
}

// ---------------------------------------------------------------------------
// Raw SSR HTML, headers and the boundary payload

/** Decoded `name="value"` attribute values of every `data-strata-*` attribute in the HTML. */
function strataAttributes(html: string): string[] {
  return [...html.matchAll(/\sdata-strata-[a-z-]+="([^"]*)"/g)].map((match) =>
    decodeAttribute(match[1] ?? ""),
  );
}

function checkPayload(html: string): boolean {
  const host = html.match(/<security-probe\s[^>]*>/)?.[0] ?? "";
  const attribute = (name: string) => host.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  const raw = attribute("data-strata-props");
  const decoded = raw === undefined ? "" : decodeAttribute(raw);
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(decoded);
  } catch {
    // reported by the checks below
  }

  const entries =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.entries(parsed)
      : [];
  const flat = entries.every(
    ([, value]) =>
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)),
  );

  console.log(`boundary host: ${host}`);
  console.log(`decoded data-strata-props: ${decoded}`);

  return all([
    check(
      'the boundary host carries data-strata-client, data-strata-protocol="1", data-strata-props and ngh, in that order',
      /^<security-probe data-strata-client="security-probe" data-strata-protocol="1" data-strata-props="[^"]*" ngh="\d+">$/.test(
        host,
      ),
      host,
    ),
    check(
      "protocol v1 payload: a flat JSON object of string | finite number | boolean | null, ≤ 64 props, ≤ 64 KiB UTF-8",
      flat &&
        entries.length > 0 &&
        entries.length <= 64 &&
        Buffer.byteLength(decoded, "utf8") <= 64 * 1024,
      decoded,
    ),
    check(
      "the payload has exactly the props the Server Component passed: label, control, enabled",
      JSON.stringify(entries.map(([key]) => key).sort()) ===
        JSON.stringify(["control", "enabled", "label"]),
      JSON.stringify(entries.map(([key]) => key)),
    ),
    check(
      `${PUBLIC_CONTROL_CANARY.label} ✓ boundary props: prop "control" equals it exactly`,
      (parsed as { control?: unknown } | null)?.control === PUBLIC_CONTROL_CANARY.value,
      decoded,
    ),
    expectAbsent(
      "boundary props (parsed keys and values)",
      DATA_SECRET_CANARY,
      JSON.stringify(entries),
    ),
    expectAbsent(
      "boundary props attribute (raw, still HTML-escaped)",
      DATA_SECRET_CANARY,
      raw ?? "",
    ),
  ]);
}

/**
 * `GET /server-component-security`: status, headers, the whole raw body (not
 * `textContent`), every region of it, and the boundary payload.
 */
export async function checkSecurityHttp(target: RuntimeTarget): Promise<{
  readonly ssrHtml: boolean;
  readonly headers: boolean;
  readonly payload: boolean;
  readonly response: CapturedResponse;
}> {
  section(`${target.name}: GET ${SECURITY_ROUTE} (raw response)`);

  const response = await captureResponse(`${target.baseUrl}${SECURITY_ROUTE}`);
  const regions = htmlRegions(response.body);

  console.log(summarize(response));
  console.log(`response headers:\n${headerBlock(response)}`);
  console.log(
    `regions scanned: ${regions.comments.length} comments, ${regions.inlineScripts.length} inline scripts, ` +
      `ng-state ${regions.ngState.length} chars, ${regions.hydrationAnnotations.length} ngh annotations, ` +
      `${strataAttributes(response.body).length} data-strata-* attributes`,
  );

  const ssrHtml = all([
    check(
      "HTTP 200 text/html",
      response.status === 200 && !!response.contentType?.includes("text/html"),
      `${response.status} ${response.contentType}`,
    ),
    check(
      "the Server Component rendered and the server-only repository verified (Internal verification: ready)",
      response.body.includes("Internal verification: ready"),
    ),
    expectPresent(
      "raw SSR HTML (as attribute data-strata-props, escaped)",
      PUBLIC_CONTROL_CANARY,
      response.body,
    ),
    expectPresent(
      "visible SSR HTML (the island's rendered text)",
      PUBLIC_CONTROL_CANARY,
      response.body.match(/<p data-field="control">([^<]*)<\/p>/)?.[1] ?? "",
    ),
    expectAbsent("raw SSR HTML body (whole response)", DATA_SECRET_CANARY, response.body),
    expectAbsent("HTML comments", DATA_SECRET_CANARY, regions.comments.join("\n")),
    expectAbsent("inline scripts", DATA_SECRET_CANARY, regions.inlineScripts.join("\n")),
    expectAbsent("Angular serialized state (ng-state)", DATA_SECRET_CANARY, regions.ngState),
    expectAbsent(
      "Angular hydration annotations (ngh)",
      DATA_SECRET_CANARY,
      regions.hydrationAnnotations.join("\n"),
    ),
    expectAbsent(
      "data-strata-client / -protocol / -props attributes",
      DATA_SECRET_CANARY,
      strataAttributes(response.body).join("\n"),
    ),
    check(
      "no global payload registry in the HTML (no __STRATA_DATA__ / window assignment)",
      !/__STRATA_[A-Z_]*DATA|window\.__STRATA|globalThis\.__STRATA/.test(response.body),
    ),
  ]);

  const headers = all([
    expectAbsent("every response header", DATA_SECRET_CANARY, headerBlock(response)),
    check("no Set-Cookie header", !response.headers.some(([name]) => name === "set-cookie")),
  ]);

  return { ssrHtml, headers, payload: checkPayload(response.body), response };
}

// ---------------------------------------------------------------------------
// Browser: hydrated DOM, interaction, network

interface PublicResponse {
  readonly url: string;
  readonly status: number;
  readonly kind: "document" | "script" | "fetch/xhr" | "stylesheet" | "other text";
  readonly body: string;
}

const TEXT_TYPE = /text|json|javascript|ecmascript|xml|css|svg/i;
const MAX_BODY_CHARS = 4 * 1024 * 1024;

/** Records every public text/JSON/script response of a page, for scanning. */
function recordPublicResponses(page: Page): { collect(): Promise<PublicResponse[]> } {
  const pending: Promise<PublicResponse | null>[] = [];

  page.on("response", (response) => {
    pending.push(
      (async (): Promise<PublicResponse | null> => {
        const type = response.request().resourceType();
        const contentType = response.headers()["content-type"] ?? "";

        if (type !== "document" && type !== "script" && !TEXT_TYPE.test(contentType)) return null;

        try {
          const body = await response.text();

          if (body.length > MAX_BODY_CHARS) return null;

          return {
            url: response.url(),
            status: response.status(),
            kind:
              type === "document"
                ? "document"
                : type === "script"
                  ? "script"
                  : type === "fetch" || type === "xhr"
                    ? "fetch/xhr"
                    : type === "stylesheet"
                      ? "stylesheet"
                      : "other text",
            body,
          };
        } catch {
          return null; // a redirect or a response without a readable body
        }
      })(),
    );
  });

  return {
    async collect() {
      return (await Promise.all(pending)).filter(
        (entry): entry is PublicResponse => entry !== null,
      );
    },
  };
}

/** The page's DOM and storage as the user could read them. */
async function readPage(page: Page): Promise<{
  readonly outerHtml: string;
  readonly innerText: string;
  readonly storage: string;
}> {
  return {
    outerHtml: await page.evaluate<string>("document.documentElement.outerHTML"),
    innerText: await page.evaluate<string>("document.body.innerText"),
    storage: `${await page.evaluate<string>(
      "JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie })",
    )}${JSON.stringify(await page.context().cookies())}`,
  };
}

function checkNetwork(label: string, entries: readonly PublicResponse[]): boolean {
  const kinds: Partial<Record<PublicResponse["kind"], PublicResponse[]>> = {};

  for (const entry of entries) (kinds[entry.kind] ??= []).push(entry);

  console.log(
    `${label}: ${entries.length} public text/script responses scanned — ` +
      Object.entries(kinds)
        .map(([kind, list]) => `${kind} ${list?.length ?? 0}`)
        .join(", "),
  );

  return all([
    check(
      `${label}: the document and at least one script were observed`,
      !!kinds["document"] && !!kinds["script"],
    ),
    ...(["document", "script", "fetch/xhr", "stylesheet", "other text"] as const).flatMap(
      (kind) => {
        const list = kinds[kind] ?? [];

        // A kind the page never requested has nothing to leak (fetch/xhr: none expected).
        if (list.length === 0) return [];

        return [
          expectAbsent(
            `${label} ${kind} responses (${list.length}: ${list
              .map((entry) => new URL(entry.url).pathname)
              .join(", ")
              .slice(0, 160)})`,
            DATA_SECRET_CANARY,
            list.map((entry) => entry.body).join("\n"),
          ),
        ];
      },
    ),
  ]);
}

/**
 * Chromium on `/server-component-security`: hydration, then a real click on the
 * `SecurityProbeIsland`, scanning the hydrated DOM, text, storage and every
 * public network response before and after.
 */
export async function checkSecurityBrowser(
  target: RuntimeTarget,
  browser: Browser,
): Promise<{
  readonly hydratedDom: boolean;
  readonly network: boolean;
  readonly control: boolean;
}> {
  section(`${target.name}: Chromium on ${SECURITY_ROUTE} — hydration, interaction, network`);

  const page = await browser.newPage();
  const problems: string[] = [];
  const network = recordPublicResponses(page);

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  try {
    await page.goto(`${target.baseUrl}${SECURITY_ROUTE}`, { waitUntil: "load" });

    const hydrated = await page
      .waitForSelector("[data-strata-hydrated]", { state: "attached", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const before = await readPage(page);
    const controlText = await page.locator('security-probe [data-field="control"]').textContent();

    await page.locator("security-probe button").click();
    await page
      .waitForFunction(
        "document.querySelector('security-probe output')?.textContent === 'Pings: 1'",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);

    const after = await readPage(page);
    const output = await page.locator("security-probe output").textContent();
    const globals = await page.evaluate<string[]>(
      "Object.keys(window).filter((key) => /strata/i.test(key))",
    );
    const entries = await network.collect();

    const hydratedDom = all([
      check("the Server Component host is marked hydrated (every boundary committed)", hydrated),
      check(
        'the island is interactive: click → "Pings: 1" (a real interaction, then scanned again)',
        output === "Pings: 1",
        String(output),
      ),
      expectAbsent(
        "hydrated document.documentElement.outerHTML",
        DATA_SECRET_CANARY,
        before.outerHtml,
      ),
      expectAbsent("hydrated document.body.innerText", DATA_SECRET_CANARY, before.innerText),
      expectAbsent("outerHTML after the interaction", DATA_SECRET_CANARY, after.outerHtml),
      expectAbsent("innerText after the interaction", DATA_SECRET_CANARY, after.innerText),
      expectAbsent("cookies, localStorage and sessionStorage", DATA_SECRET_CANARY, after.storage),
      check(
        "no global payload registry in the browser: the only strata-named window keys are the fixture's own probes (src/probes), not the runtime's",
        globals.every((key) => FIXTURE_PROBES.has(key)),
        globals.join(", "),
      ),
      check(
        "no console errors, warnings or page errors",
        problems.length === 0,
        problems.join(" | "),
      ),
    ]);
    const control = all([
      check(
        `${PUBLIC_CONTROL_CANARY.label} ✓ client input: the island's rendered input equals it`,
        controlText === PUBLIC_CONTROL_CANARY.value,
        String(controlText),
      ),
      expectPresent("hydrated outerHTML", PUBLIC_CONTROL_CANARY, before.outerHtml),
      expectPresent("hydrated body.innerText", PUBLIC_CONTROL_CANARY, before.innerText),
      expectPresent("outerHTML after the interaction", PUBLIC_CONTROL_CANARY, after.outerHtml),
      expectPresent(
        "the document response the browser received",
        PUBLIC_CONTROL_CANARY,
        entries.find((entry) => entry.kind === "document")?.body ?? "",
      ),
    ]);

    return { hydratedDom, network: checkNetwork(target.name, entries), control };
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// Secret-bearing errors

/** Waits for the server's log to mention `text` (an operator surface, written asynchronously). */
async function logMentions(target: RuntimeTarget, from: number, text: string, waitMs = 4_000) {
  for (let waited = 0; waited < waitMs; waited += 100) {
    if (target.output().slice(from).includes(text)) return true;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return target.output().slice(from).includes(text);
}

/**
 * The same secret-bearing production error through three shapes (plain, `cause`,
 * `AggregateError`), each in its own request. Public surface: response status,
 * content type, headers, body, and the browser's console, page errors and
 * rendered document. The server log is the operator's surface: recorded
 * separately, never counted as a public leak. No status is required: Angular
 * and Analog own it.
 */
export async function checkSecretErrors(
  target: RuntimeTarget,
  browser: Browser,
): Promise<{ readonly responses: boolean; readonly browser: boolean }> {
  const results: boolean[] = [];
  const browserResults: boolean[] = [];

  // Control: the same route with a mode that does not throw renders its element,
  // so a response without it is a render that really failed, not a missing route.
  section(`${target.name}: error-path control (${failureRoute("none")} does not throw)`);

  const control = await captureResponse(`${target.baseUrl}${failureRoute("none")}`);

  results.push(
    check(
      "the control route renders its Server Component (so the failure routes below are real failures)",
      control.status === 200 && control.body.includes("data-security-failure"),
      summarize(control),
    ),
  );

  for (const mode of FAILURE_MODES) {
    section(
      `${target.name}: secret-bearing production error — ${mode} (GET ${failureRoute(mode)})`,
    );

    const before = target.output().length;
    const response = await captureResponse(`${target.baseUrl}${failureRoute(mode)}`);
    const logged = await logMentions(target, before, FAILURE_LOG[mode]);
    const log = stripVTControlCharacters(target.output().slice(before));

    console.log(`public response: ${summarize(response)}`);
    console.log(`response headers:\n${headerBlock(response)}`);
    console.log(
      `response body (${response.body.length} chars): ${JSON.stringify(response.body.slice(0, 1_500))}`,
    );
    console.log(
      `operator log (separate from the public response): thrown error visible ${logged ? "yes" : "no"}; ` +
        `${DATA_SECRET_CANARY.label} in log ${leaksIn(DATA_SECRET_CANARY, log).length > 0 ? "yes" : "no"}; ` +
        `stack frames in log ${/\n\s+at /.test(log) ? "yes" : "no"}`,
    );
    console.log(
      `characterized: the production render answered HTTP ${response.status} ${response.contentType ?? ""} ` +
        `(${response.body.includes("data-security-failure") ? "component rendered?!" : "the failing component is absent"}); status owned by Angular/Analog`,
    );

    results.push(
      check(
        "the error path ran: the failing component did not render",
        !response.body.includes("data-security-failure"),
      ),
      check(
        `the thrown error is in the server log (operator surface; not a public leak): "${FAILURE_LOG[mode].slice(0, 40)}"`,
        logged,
        log.slice(0, 600),
      ),
      check(
        "scanner control: the same scans flag the operator log (canary, stack frames, absolute paths)",
        leaksIn(DATA_SECRET_CANARY, log).length > 0 &&
          internalsIn(log, SENSITIVE_ROOTS).length >= 3,
        internalsIn(log, SENSITIVE_ROOTS).join("; "),
      ),
      expectResponseAbsent(`${mode} error`, DATA_SECRET_CANARY, response),
      expectNoInternals(`${mode} error response body`, response.body, SENSITIVE_ROOTS),
      expectNoInternals(`${mode} error response headers`, headerBlock(response), SENSITIVE_ROOTS),
    );
  }

  for (const mode of FAILURE_MODES) {
    section(`${target.name}: browser error surface — ${mode}`);

    const page = await browser.newPage();
    const messages: string[] = [];
    const errors: string[] = [];
    const network = recordPublicResponses(page);

    page.on("console", (message) => messages.push(`console.${message.type()}: ${message.text()}`));
    page.on("pageerror", (error) =>
      errors.push(`pageerror: ${error.message}\n${error.stack ?? ""}`),
    );

    try {
      await page.goto(`${target.baseUrl}${failureRoute(mode)}`, { waitUntil: "load" });
      await page.waitForTimeout(1_000);

      const seen = await readPage(page);
      const entries = await network.collect();

      console.log(
        `browser: ${messages.length} console messages, ${errors.length} page errors, document ${seen.outerHtml.length} chars`,
      );
      browserResults.push(
        expectAbsent("console messages", DATA_SECRET_CANARY, messages.join("\n")),
        expectAbsent("page errors", DATA_SECRET_CANARY, errors.join("\n")),
        expectAbsent("rendered document (outerHTML)", DATA_SECRET_CANARY, seen.outerHtml),
        expectAbsent("rendered text (innerText)", DATA_SECRET_CANARY, seen.innerText),
        expectNoInternals("rendered document", seen.outerHtml, SENSITIVE_ROOTS),
        expectNoInternals(
          "console messages and page errors",
          [...messages, ...errors].join("\n"),
          SENSITIVE_ROOTS,
        ),
        checkNetwork(`${target.name} ${mode} error`, entries),
      );
    } finally {
      await page.close();
    }
  }

  return { responses: all(results), browser: all(browserResults) };
}

// ---------------------------------------------------------------------------
// Unsupported values crossing [strataClient]

/**
 * A cast smuggles the repository itself, and a nested object holding the DATA
 * canary, into `[strataClient]`. The runtime must reject both before
 * serialization; the diagnostic names the prop and the value's type and prints
 * nothing of the value.
 */
export async function checkCrossings(target: RuntimeTarget): Promise<boolean> {
  const results: boolean[] = [];
  const shapes = [
    {
      mode: "repository",
      diagnostic:
        /^\[strata\] Cannot serialize client boundary <security-probe>: prop "repository": an instance of \w+ is not supported\.$/m,
      expect: 'prop "repository": an instance of <the repository class> is not supported',
    },
    {
      mode: "nested",
      diagnostic:
        /^\[strata\] Cannot serialize client boundary <security-probe>: prop "configuration": a nested object is not supported\.$/m,
      expect: 'prop "configuration": a nested object is not supported',
    },
  ] as const;

  for (const { mode, diagnostic, expect } of shapes) {
    section(
      `${target.name}: unsupported value crossing [strataClient] — ${mode} (GET ${crossingRoute(mode)})`,
    );

    const before = target.output().length;
    const response = await captureResponse(`${target.baseUrl}${crossingRoute(mode)}`);
    const logged = await logMentions(target, before, "Cannot serialize client boundary");
    const log = stripVTControlCharacters(target.output().slice(before));
    const line = log.match(/\[strata\] Cannot serialize client boundary[^\n]*/)?.[0] ?? "(none)";

    console.log(`public response: ${summarize(response)}`);
    console.log(`server log diagnostic: ${line}`);
    results.push(
      check(
        "StrataBoundaryError reached the server's error handler",
        /StrataBoundaryError/.test(log) && logged,
        log.slice(0, 400),
      ),
      check(`the diagnostic names ${expect}`, diagnostic.test(line), line),
      check(
        "the diagnostic is a type description: it prints no object contents or JSON",
        !/[{}]|\bendpoint\b|"credential"/.test(line) && line.length < 220,
        line,
      ),
      expectAbsent("server log of the rejection (diagnostic and stack)", DATA_SECRET_CANARY, log),
      check(
        "rejected before serialization: the boundary host has no data-strata-props",
        !/<security-probe[^>]*data-strata-props/.test(response.body) &&
          /<security-probe[^>]*data-strata-protocol="1"/.test(response.body),
        response.body.match(/<security-probe[^>]*>/)?.[0],
      ),
      expectResponseAbsent(`${mode} crossing`, DATA_SECRET_CANARY, response),
      check(
        "the repository class is not in the HTML (no object, no JSON dump)",
        !response.body.includes("SecurityRepository") && !response.body.includes("credential"),
      ),
    );
  }

  return all(results);
}

// ---------------------------------------------------------------------------
// Cross-request isolation

/**
 * Overlapping requests for `/server-component-security-request/a` and `/b`: the
 * route parameter is the only request-varying input Angular offers a routed
 * Server Component (there is no Strata request context). Each render is held
 * open for 250 ms so the requests genuinely interleave.
 */
export async function checkCrossRequest(target: RuntimeTarget): Promise<boolean> {
  section(`${target.name}: overlapping requests — A → PUBLIC_A, B → PUBLIC_B`);

  const ids = Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? "a" : "b"));
  const started = Date.now();
  const responses = await Promise.all(
    ids.map((id) => captureResponse(`${target.baseUrl}${requestRoute(id)}`)),
  );
  const elapsed = Date.now() - started;
  const labelOf = (response: CapturedResponse) =>
    response.body.match(/<p data-request[^>]*>([^<]*)<\/p>/)?.[1] ?? "(none)";
  const wrong = responses
    .map((response, index) => ({ id: ids[index], label: labelOf(response), response }))
    .filter(({ id, label }) => label !== `PUBLIC_${(id ?? "").toUpperCase()}`);

  console.log(
    `${responses.length} requests (12 for A, 12 for B) in ${elapsed} ms; each render holds ${250} ms, ` +
      `so a serial server would take ≥ ${responses.length * 250} ms`,
  );

  return all([
    check(
      "every response renders its own request's value (A → PUBLIC_A only, B → PUBLIC_B only)",
      wrong.length === 0,
      wrong.map(({ id, label }) => `${id}→${label}`).join(", "),
    ),
    check(
      "no response carries the other request's value",
      responses.every((response, index) => {
        const other = ids[index] === "a" ? "PUBLIC_B" : "PUBLIC_A";

        return !response.body.includes(other);
      }),
    ),
    check(
      "the requests overlapped (the whole batch took less than a third of the serial time)",
      elapsed < (responses.length * 250) / 3,
      `${elapsed} ms`,
    ),
    check(
      "the server-only repository verified in every response (Internal verification: ready), no DATA canary",
      responses.every(
        (response) =>
          response.body.includes("Internal verification: ready") &&
          leaksIn(DATA_SECRET_CANARY, response.body).length === 0,
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Build diagnostics

const ILLEGAL_DIR = "src/app/security-illegal";
const ILLEGAL_PAGE = "src/app/pages/security-illegal.page.ts";
const ILLEGAL_ISLAND = `${ILLEGAL_DIR}/illegal-island.component.ts`;

function writeIllegal(body: string, imports: string): void {
  const files: Record<string, string> = {
    [ILLEGAL_PAGE]: `import { Component } from "@angular/core";

import { SecurityIllegalIslandComponent } from "../security-illegal/illegal-island.component";

@Component({
  selector: "app-security-illegal-page",
  imports: [SecurityIllegalIslandComponent],
  template: "<security-illegal />",
})
export default class SecurityIllegalPage {}
`,
    [ILLEGAL_ISLAND]: `import { ChangeDetectionStrategy, Component } from "@angular/core";
${imports}

@Component({
  selector: "security-illegal",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: "<p>{{ text }}</p>",
})
export class SecurityIllegalIslandComponent {
${body}
}
`,
  };

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixtureDir, path)), { recursive: true });
    writeFileSync(join(fixtureDir, path), text);
  }
}

/** The temporary illegal-import modules are always removed. */
function removeIllegal(): void {
  rmSync(join(fixtureDir, ILLEGAL_DIR), { recursive: true, force: true });
  rmSync(join(fixtureDir, ILLEGAL_PAGE), { force: true });
}

/**
 * PR #49's illegal-import diagnostic, for the DATA secret module: the build
 * fails naming module, importer and reason, and the combined stdout/stderr of
 * the whole failed build carries neither the canary nor the module's source.
 */
export function checkBuildDiagnosticConfidentiality(): boolean {
  section("Build diagnostics: an illegal browser import of the DATA secret module");

  const results: boolean[] = [];
  const shapes = [
    {
      shape: "direct import",
      imports: `import { readInternalCredential } from "../server-component-security/security-secret";`,
      body: "  protected readonly text = readInternalCredential().length;",
      module: SECURITY_MODULES.secret,
    },
    {
      shape: "?raw import (the module's source as a string)",
      imports: `import source from "../server-component-security/security-secret.ts?raw";`,
      body: "  protected readonly text = source.length;",
      module: `${SECURITY_MODULES.secret}?raw`,
    },
    {
      shape: "import of the repository that holds the secret",
      imports: `import { SecurityRepository } from "../server-component-security/security-repository";`,
      body: "  protected readonly text = new SecurityRepository().verifyInternalConfiguration();",
      module: SECURITY_MODULES.repository,
    },
  ];

  try {
    for (const { shape, imports, body, module } of shapes) {
      writeIllegal(body, imports);
      rmSync(distDir, { recursive: true, force: true });

      const result = run("pnpm", ["exec", "vite", "build"], { cwd: fixtureDir });
      const output = `${result.stdout}\n${result.stderr}`;
      const start = output.indexOf("[strata] Server-only module entered the browser graph:");
      const diagnostic = start === -1 ? "" : output.slice(start).split("\n").slice(0, 4).join("\n");

      console.log(`\n${shape}:\n${diagnostic || output.slice(-1_200)}`);
      results.push(
        check(`${shape}: build exits non-zero`, result.status !== 0, String(result.status)),
        check(
          `${shape}: diagnostic names the module, the importer and the reason`,
          diagnostic.startsWith(
            `[strata] Server-only module entered the browser graph: ${module}\nImported from: ${ILLEGAL_ISLAND}\nReason: the module declares`,
          ),
          diagnostic,
        ),
        expectAbsent(
          `${shape}: combined stdout and stderr of the failed build (${output.length} chars)`,
          DATA_SECRET_CANARY,
          output,
        ),
        check(
          `${shape}: the output does not print the module's source`,
          !/readInternalCredential\(\)\s*\{|Math\.imul\(hash \^|EXPECTED_CREDENTIAL_DIGEST\s*=|failInternally\(failure/.test(
            output,
          ),
        ),
      );
    }
  } finally {
    removeIllegal();
  }

  results.push(
    check(
      "no temporary illegal module left in the fixture",
      !existsSync(join(fixtureDir, ILLEGAL_DIR)) && !existsSync(join(fixtureDir, ILLEGAL_PAGE)),
    ),
  );

  return all(results);
}

export async function openBrowser(): Promise<Browser> {
  return chromium.launch();
}
