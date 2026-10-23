import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  countUnlinkedPartialDeclarations,
  findUncompiledAngularClasses,
} from "../../../packages/server-components/src/vite/aot-integrity.ts";

/**
 * The SSR integrity contract of the qualification suites
 * (docs/research/server-component-ssr-integrity-v07.md).
 *
 * An HTTP 200 proves only that something answered. Angular and Analog swallow
 * an unexpected render error and still return 200 (no supported response-status
 * bridge exists, docs/research/server-component-ssr-response.md), so a
 * qualification passes only when the document itself is complete, the server
 * log is clean, and the built output honours the compilation contract. Every
 * failure carries one explicit class, so a red run says which layer broke.
 *
 *   build-compilation        an Angular class reached the output not compiled (JIT fallback), or a
 *                            partial declaration was never linked
 *   server-bootstrap         the server logged an Angular/bootstrap error while rendering
 *   incomplete-ssr           HTTP status/type wrong, or the document is an empty shell or lacks the
 *                            expected server-owned content / islands
 *   boundary-serialization   a boundary is present but its protocol or props are not structurally valid
 *   client-hydration         the browser did not hydrate the SSR DOM or logged an error
 *   graph-confidentiality    server-only content reached a public document or browser file
 *
 * Diagnostics are bounded and never carry document text, file text, headers or cookies: only
 * counts, the caller's own marker labels and class names.
 */

export type SsrFailureClass =
  | "build-compilation"
  | "server-bootstrap"
  | "incomplete-ssr"
  | "boundary-serialization"
  | "client-hydration"
  | "graph-confidentiality";

export interface SsrFinding {
  readonly class: SsrFailureClass;
  readonly detail: string;
}

export interface ExpectedBoundary {
  readonly selector: string;
  readonly protocol: "1" | "2";
}

export interface SsrExpectation {
  /** Server-owned text/markup the document must contain, by a stable label (the label is reported, not the text). */
  readonly content: Readonly<Record<string, string | RegExp>>;
  readonly boundaries: readonly ExpectedBoundary[];
  /** Synthetic server-only values that must never appear in a public document, by label. */
  readonly forbidden?: Readonly<Record<string, string>>;
}

export interface SsrReply {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

export interface SsrAssessment {
  readonly ok: boolean;
  readonly findings: readonly SsrFinding[];
  /** Counts and labels only. */
  readonly summary: {
    readonly status: number;
    readonly contentType: string | null;
    readonly bytes: number;
    readonly appRootEmpty: boolean;
    readonly missing: readonly string[];
    readonly boundaries: number;
    readonly logLines: number;
  };
}

/** Log lines that mean Angular failed to compile a class at runtime. */
const COMPILATION_LOG =
  /JIT compiler unavailable|needs to be compiled using the JIT|JIT compilation/;
/** Log lines that mean the server failed while bootstrapping or rendering. */
const BOOTSTRAP_LOG =
  /\bERROR\b|\bNG0\d{3,4}\b|Unhandled(?:Promise)?Rejection|TypeError:|ReferenceError:/;

const APP_ROOT = /<app-root\b[^>]*>([\s\S]*?)<\/app-root>/;
/** What an empty Angular shell holds: nothing, or only the router outlet. */
const EMPTY_SHELL = /^\s*(?:<router-outlet\b[^>]*>\s*<\/router-outlet>\s*)?$/;

function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** The first tag of `selector` carrying a `data-strata-client` attribute for it, as written. */
function boundaryTag(html: string, selector: string): string | undefined {
  return html.match(new RegExp(`<${selector}\\b[^>]*data-strata-client="${selector}"[^>]*>`))?.[0];
}

/** One log line, bounded and without filesystem locations. */
function excerpt(line: string): string {
  return line
    .replace(/(?:file:\/\/)?(?:\/[\w.@~+-]+){3,}/g, "<path>")
    .trim()
    .slice(0, 160);
}

function logFindings(serverLog: string): SsrFinding[] {
  const lines = serverLog.split("\n");
  const compilation = lines.filter((line) => COMPILATION_LOG.test(line));
  const other = lines.filter((line) => BOOTSTRAP_LOG.test(line) && !COMPILATION_LOG.test(line));
  const findings: SsrFinding[] = [];

  if (compilation.length > 0) {
    findings.push({
      class: "build-compilation",
      detail: `the server log reports Angular JIT compilation (${compilation.length} line(s)): a class was not AOT-compiled; first: ${excerpt(compilation[0] ?? "")}`,
    });
  }

  if (other.length > 0) {
    findings.push({
      class: "server-bootstrap",
      detail: `the server log reports ${other.length} error line(s) while rendering; first: ${excerpt(other[0] ?? "")}`,
    });
  }

  return findings;
}

/**
 * Classifies one SSR answer and the server log it produced. Pure: no I/O, no clock.
 * `ok` only when the document is complete AND the log is clean.
 */
export function assessSsrDocument(
  reply: SsrReply,
  serverLog: string,
  expected: SsrExpectation,
): SsrAssessment {
  const findings: SsrFinding[] = [...logFindings(serverLog)];
  const html = reply.body;
  const shell = html.match(APP_ROOT)?.[1];
  const appRootEmpty = shell === undefined || EMPTY_SHELL.test(shell);
  const missing = Object.entries(expected.content)
    .filter(([, needle]) =>
      typeof needle === "string" ? !html.includes(needle) : !needle.test(html),
    )
    .map(([label]) => label);

  if (reply.status !== 200 || !reply.contentType?.includes("text/html")) {
    findings.push({
      class: "incomplete-ssr",
      detail: `expected a 200 text/html document, received ${reply.status} ${reply.contentType ?? "without a content type"}`,
    });
  }

  if (appRootEmpty) {
    findings.push({
      class: "incomplete-ssr",
      detail: `the document is an empty Angular shell (${html.length} bytes, nothing rendered in app-root)`,
    });
  }

  if (missing.length > 0) {
    findings.push({
      class: "incomplete-ssr",
      detail: `server-owned content missing: ${missing.join(", ")}`,
    });
  }

  let boundaries = 0;

  for (const boundary of expected.boundaries) {
    const tag = boundaryTag(html, boundary.selector);

    if (tag === undefined) {
      // An absent boundary in an otherwise empty document is the shell's finding, not a second one.
      if (!appRootEmpty) {
        findings.push({
          class: "incomplete-ssr",
          detail: `island <${boundary.selector}> is not in the document`,
        });
      }

      continue;
    }

    boundaries++;

    const protocol = tag.match(/data-strata-protocol="([^"]*)"/)?.[1];
    const props = tag.match(/data-strata-props="([^"]*)"/)?.[1];
    let propsValid = false;

    if (props !== undefined) {
      try {
        const parsed: unknown = JSON.parse(unescapeAttribute(props));

        propsValid = parsed !== null && typeof parsed === "object";
      } catch {
        propsValid = false;
      }
    }

    if (protocol !== boundary.protocol || !propsValid) {
      findings.push({
        class: "boundary-serialization",
        detail: `<${boundary.selector}> expects protocol ${boundary.protocol} with JSON props; found protocol ${protocol ?? "none"}, props ${propsValid ? "valid" : props === undefined ? "absent" : "not valid JSON"}`,
      });
    } else if (!/\bngh="\d+"/.test(tag)) {
      findings.push({
        class: "boundary-serialization",
        detail: `<${boundary.selector}> has no ngh hydration annotation`,
      });
    }
  }

  for (const [label, value] of Object.entries(expected.forbidden ?? {})) {
    if (html.includes(value)) {
      findings.push({
        class: "graph-confidentiality",
        detail: `server-only value "${label}" is in the public document`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    summary: {
      status: reply.status,
      contentType: reply.contentType,
      bytes: html.length,
      appRootEmpty,
      missing,
      boundaries,
      logLines: serverLog.split("\n").filter(Boolean).length,
    },
  };
}

/** One readable line per assessment, for a check's failure detail. */
export function describeAssessment(assessment: SsrAssessment): string {
  if (assessment.ok) return "complete document, clean server log";

  const classes = [...new Set(assessment.findings.map((finding) => finding.class))].join(", ");

  return `${classes}: ${assessment.findings.map((finding) => finding.detail).join("; ")}`.slice(
    0,
    700,
  );
}

/** Hydration outcome of one browser observation (lib/browser.ts) as findings. */
export function assessHydration(observation: {
  readonly hydratedWithinTimeout: boolean;
  readonly errors: readonly string[];
  readonly sameNodes: Readonly<Record<string, boolean>>;
}): SsrFinding[] {
  const findings: SsrFinding[] = [];
  const replaced = Object.entries(observation.sameNodes)
    .filter(([, same]) => !same)
    .map(([name]) => name);

  if (!observation.hydratedWithinTimeout) {
    findings.push({ class: "client-hydration", detail: "the islands did not hydrate" });
  }

  if (replaced.length > 0) {
    findings.push({
      class: "client-hydration",
      detail: `SSR DOM was replaced, not reused: ${replaced.join(", ")}`,
    });
  }

  if (observation.errors.length > 0) {
    findings.push({
      class: "client-hydration",
      detail: `${observation.errors.length} browser console error(s)/warning(s)`,
    });
  }

  return findings;
}

export interface OutputScan {
  readonly scanned: number;
  /** Compiled definitions found (`ɵɵdefineComponent(`, …): proves the scan was not vacuous. */
  readonly definitions: number;
  readonly uncompiled: readonly { readonly file: string; readonly classes: readonly string[] }[];
  readonly unlinked: readonly { readonly file: string; readonly count: number }[];
}

const SERVER_OUTPUT_FILE = /\.(?:[cm]?js)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * The compilation contract over built output (the final artifacts, after
 * bundling and Nitro): no emitted module applies an Angular decorator or calls
 * a partial declaration. Reuses the package's own structural check, so the
 * build-time gate and this end-of-pipe scan cannot drift.
 *
 * `classes` roots are scanned for an Angular decorator still applied (the app's own
 * classes live in every one of them). `partials` roots are scanned for unlinked
 * partial declarations: the Vite output, where the linker runs. Nitro's traced
 * third-party copies are not held to it (see the research report).
 */
export function scanBuildOutput(
  roots: { readonly classes: readonly string[]; readonly partials: readonly string[] },
  relativeTo: string,
): OutputScan {
  const uncompiled: { file: string; classes: string[] }[] = [];
  const unlinked: { file: string; count: number }[] = [];
  const partialRoots = roots.partials.map((root) => `${root}/`);
  let scanned = 0;
  let definitions = 0;

  for (const root of new Set([...roots.classes, ...roots.partials])) {
    let files: string[];

    try {
      files = walk(root);
    } catch {
      continue;
    }

    for (const path of files) {
      if (!SERVER_OUTPUT_FILE.test(path)) continue;

      const code = readFileSync(path, "utf8");
      const file = path.startsWith(relativeTo) ? path.slice(relativeTo.length + 1) : path;
      const classes = findUncompiledAngularClasses(code, path);

      scanned++;
      definitions += code.match(/ɵɵdefine(?:Component|Directive|Injectable|Pipe)\(/g)?.length ?? 0;

      if (classes.length > 0) {
        uncompiled.push({
          file,
          classes: classes.map((entry) => `@${entry.decorator} ${entry.className ?? "?"}`),
        });
      }

      // Only output the Vite pipeline (and so Angular's linker) produced is held to this:
      // Nitro also copies packages it traced but nothing evaluates, still partial-compiled.
      if (partialRoots.some((prefix) => path.startsWith(prefix))) {
        const partial = countUnlinkedPartialDeclarations(code);

        if (partial > 0) unlinked.push({ file, count: partial });
      }
    }
  }

  return { scanned, definitions, uncompiled, unlinked };
}

export function describeScan(scan: OutputScan): string {
  const parts = [
    ...scan.uncompiled.slice(0, 3).map((entry) => `${entry.file}: ${entry.classes.join(", ")}`),
    ...scan.unlinked
      .slice(0, 3)
      .map((entry) => `${entry.file}: ${entry.count} partial declaration(s)`),
  ];

  return `${scan.scanned} file(s), ${scan.definitions} compiled definition(s); ${parts.join("; ") || "none uncompiled"}`.slice(
    0,
    700,
  );
}

/**
 * `STRATA_DIAGNOSTICS_DIR` (CI sets it): keeps a bounded, content-free record of a
 * failed assessment so a red run can be classified without re-running it. Never
 * changes a result.
 */
export function keepIntegrityRecord(label: string, record: Record<string, unknown>): void {
  const directory = process.env["STRATA_DIAGNOSTICS_DIR"];

  if (!directory) return;

  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `ssr-integrity-${label.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.json`),
      JSON.stringify(
        {
          commit: process.env["GITHUB_SHA"] ?? null,
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          ...record,
        },
        null,
        2,
      ).slice(0, 16_000),
    );
  } catch {
    // Diagnostics must never change the result of a run.
  }
}
