export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
  origin: string;
}

const DIAGNOSTIC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;

/**
 * Classifies which declaration graph a diagnostic's file belongs to, so the
 * matrix runner can report exact ownership (H3 vs crossws vs Bun/Workers
 * type providers vs Strata vs consumer-authored) instead of attributing
 * every nonzero tsc exit to a single hard-coded cause.
 */
export function classifyOrigin(file: string): string {
  const normalized = file.replace(/\\/g, "/");

  if (/node_modules\/h3\//.test(normalized)) return "h3";
  if (/node_modules\/crossws\/dist\/_chunks\/bun/.test(normalized)) return "crossws->bun";
  if (/node_modules\/crossws\/dist\/_chunks\/cloudflare/.test(normalized))
    return "crossws->cloudflare-workers";
  if (/node_modules\/crossws\//.test(normalized)) return "crossws";
  if (
    /node_modules\/bun-types\//.test(normalized) ||
    /node_modules\/@types\/bun\//.test(normalized)
  )
    return "bun-types";
  if (/node_modules\/@cloudflare\/workers-types\//.test(normalized))
    return "cloudflare-workers-types";
  if (/node_modules\/typescript\/lib\//.test(normalized)) return "typescript-lib-conflict";
  if (/node_modules\/@strata-sc\/core\//.test(normalized)) return "strata-core";
  if (/node_modules\/@strata-sc\/h3\//.test(normalized)) return "strata-h3";
  if (/^src\//.test(normalized)) return "consumer-authored";

  return `other:${normalized}`;
}

export function parseDiagnostics(tscOutput: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const rawLine of tscOutput.split("\n")) {
    const line = rawLine.trim();
    const match = DIAGNOSTIC_LINE.exec(line);
    if (!match) continue;

    const [, file, lineNo, column, code, message] = match;
    if (!file || !lineNo || !column || !code || !message) continue;

    diagnostics.push({
      file: file.replace(/\\/g, "/"),
      line: Number(lineNo),
      column: Number(column),
      code,
      message,
      origin: classifyOrigin(file),
    });
  }

  return diagnostics;
}

export function originSummary(diagnostics: Diagnostic[]): Record<string, number> {
  const summary: Record<string, number> = {};

  for (const diagnostic of diagnostics) {
    summary[diagnostic.origin] = (summary[diagnostic.origin] ?? 0) + 1;
  }

  return summary;
}
