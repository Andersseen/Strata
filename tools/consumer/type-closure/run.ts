import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../lib/exec.ts";
import { packedTarballName } from "../lib/fs-helpers.ts";

import { FIXED_VERSIONS, MATRIX_CASES } from "./cases.ts";
import { parseDiagnostics } from "./diagnostics.ts";
import type { Diagnostic } from "./diagnostics.ts";
import {
  materializeAmbientProbeFixture,
  materializeH3OnlyFixture,
  materializeStrataConsumerFixture,
  npmInstall,
  resolvedVersion,
  typecheck,
} from "./fixtures.ts";
import { renderReport } from "./report.ts";
import type {
  AmbientControlResult,
  CaseResult,
  MismatchControlResult,
  TargetResult,
  VersionMismatchControlResult,
} from "./report.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const h3OnlySource = join(repoRoot, "tests", "consumer", "type-compatibility", "h3-only");
const ambientProbeSource = join(
  repoRoot,
  "tests",
  "consumer",
  "type-compatibility",
  "ambient-probe",
);
const mismatchControlSource = join(
  repoRoot,
  "tests",
  "consumer",
  "type-compatibility",
  "mismatch-control",
);
const strataFixtureSource = join(repoRoot, "tests", "consumer", "fixture");
const reportPath = join(repoRoot, "docs", "research", "consumer-type-closure.md");

const infrastructureFailures: string[] = [];
const selfTestFailures: string[] = [];

function targetResult(
  dir: string,
  packages: string[],
): { installResult: ReturnType<typeof npmInstall> } & TargetResult {
  const installResult = npmInstall(dir);
  const tscResult =
    installResult.status === 0 ? typecheck(dir) : { status: 1, stdout: "", stderr: "" };
  const diagnostics: Diagnostic[] =
    installResult.status === 0 ? parseDiagnostics(tscResult.stdout + tscResult.stderr) : [];
  const resolvedVersions: Record<string, string | null> = {};
  for (const pkg of packages) {
    resolvedVersions[pkg] = installResult.status === 0 ? resolvedVersion(dir, pkg) : null;
  }

  return {
    installResult,
    installStatus: installResult.status,
    tscStatus: installResult.status === 0 ? tscResult.status : null,
    diagnostics,
    resolvedVersions,
  };
}

// --- Build and pack core/h3 (independent of tools/consumer/run.ts, so the
// existing required SPEC-001 gate is never touched by this experiment) -----
const tmpRoot = mkdtempSync(join(tmpdir(), "strata-type-closure-"));
console.log(`[test:consumer:types] Temporary workspace: ${tmpRoot}`);

const buildResult = run(
  "pnpm",
  ["--filter", "@strata/core", "--filter", "@strata/h3", "run", "build"],
  { cwd: repoRoot },
);

if (buildResult.status !== 0) {
  console.error("[test:consumer:types] BLOCKED: pnpm build of @strata/core/@strata/h3 failed.");
  process.exit(1);
}

const tarballDir = join(tmpRoot, "tarballs");
mkdirSync(tarballDir, { recursive: true });

const packResult = run(
  "pnpm",
  ["--filter", "@strata/core", "--filter", "@strata/h3", "pack", "--pack-destination", tarballDir],
  { cwd: repoRoot },
);

if (packResult.status !== 0) {
  console.error("[test:consumer:types] BLOCKED: pnpm pack of @strata/core/@strata/h3 failed.");
  process.exit(1);
}

const corePath = join(tarballDir, packedTarballName(join(repoRoot, "packages", "core")));
const h3TarballPath = join(tarballDir, packedTarballName(join(repoRoot, "packages", "h3")));

if (!existsSync(corePath) || !existsSync(h3TarballPath)) {
  console.error(
    `[test:consumer:types] BLOCKED: expected tarballs missing: ${corePath}, ${h3TarballPath}`,
  );
  process.exit(1);
}

// --- Matrix cases A–D -------------------------------------------------------
const caseResults: CaseResult[] = [];

for (const matrixCase of MATRIX_CASES) {
  console.log(`[test:consumer:types] Running case ${matrixCase.id} (${matrixCase.label})...`);

  const h3OnlyDir = join(tmpRoot, `h3-only-${matrixCase.id}`);
  materializeH3OnlyFixture(h3OnlySource, h3OnlyDir, matrixCase);
  const h3OnlyTarget = targetResult(h3OnlyDir, [
    "h3",
    "crossws",
    "@types/bun",
    "bun-types",
    "@cloudflare/workers-types",
  ]);

  if (h3OnlyTarget.installResult.status !== 0) {
    infrastructureFailures.push(
      `Case ${matrixCase.id} H3-only install failed (npm exit ${h3OnlyTarget.installResult.status}).`,
    );
  } else if (h3OnlyTarget.tscStatus !== 0 && h3OnlyTarget.diagnostics.length === 0) {
    infrastructureFailures.push(
      `Case ${matrixCase.id} H3-only tsc exited ${h3OnlyTarget.tscStatus} with no parsed diagnostics (possible spawn/config failure).`,
    );
  } else if (h3OnlyTarget.resolvedVersions["h3"] !== FIXED_VERSIONS.h3) {
    infrastructureFailures.push(
      `Case ${matrixCase.id} H3-only resolved h3@${h3OnlyTarget.resolvedVersions["h3"]}, expected ${FIXED_VERSIONS.h3}.`,
    );
  }

  const strataDir = join(tmpRoot, `strata-consumer-${matrixCase.id}`);
  materializeStrataConsumerFixture(
    strataFixtureSource,
    strataDir,
    matrixCase,
    corePath,
    h3TarballPath,
  );
  const strataTarget = targetResult(strataDir, ["h3", "crossws", "@strata/core", "@strata/h3"]);

  if (strataTarget.installResult.status !== 0) {
    infrastructureFailures.push(
      `Case ${matrixCase.id} packed-Strata install failed (npm exit ${strataTarget.installResult.status}).`,
    );
  } else if (strataTarget.tscStatus !== 0 && strataTarget.diagnostics.length === 0) {
    infrastructureFailures.push(
      `Case ${matrixCase.id} packed-Strata tsc exited ${strataTarget.tscStatus} with no parsed diagnostics (possible spawn/config failure).`,
    );
  }

  const strataOnlyDiagnostics = strataTarget.diagnostics.filter(
    (d) => d.origin === "strata-core" || d.origin === "strata-h3",
  );
  if (strataOnlyDiagnostics.length > 0) {
    selfTestFailures.push(
      `Case ${matrixCase.id}: ${strataOnlyDiagnostics.length} diagnostic(s) originate in @strata/core or @strata/h3 declarations, not H3 — this would be a real Strata defect, not an upstream one: ${JSON.stringify(strataOnlyDiagnostics)}`,
    );
  }

  const eligible =
    !matrixCase.activatesForeignRuntimeTypes &&
    h3OnlyTarget.diagnostics.length === 0 &&
    strataTarget.diagnostics.length === 0 &&
    h3OnlyTarget.installResult.status === 0 &&
    strataTarget.installResult.status === 0;

  const eligibilityReason = matrixCase.activatesForeignRuntimeTypes
    ? "Disqualified: activates Bun/Workers ambient runtime types for a Node-only consumer (stop rule), independent of exit code."
    : eligible
      ? "Zero diagnostics on both the H3-only reproduction and the packed Strata consumer under Node-only types."
      : `Not eligible: ${h3OnlyTarget.diagnostics.length} H3-only diagnostic(s), ${strataTarget.diagnostics.length} packed-Strata diagnostic(s).`;

  caseResults.push({
    matrixCase,
    h3Only: h3OnlyTarget,
    strataConsumer: strataTarget,
    eligible,
    eligibilityReason,
  });
}

const promotedCandidate = caseResults.find((c) => c.eligible)?.matrixCase.id ?? null;

// --- Negative ambient controls ----------------------------------------------
const caseB = MATRIX_CASES.find((c) => c.id === "B")!;
const caseDFull = MATRIX_CASES.find((c) => c.id === "D-full-providers")!;

function runAmbientControl(
  label: string,
  lib: string[],
  types: string[],
  devDeps: Record<string, string>,
): AmbientControlResult {
  const dir = join(tmpRoot, `ambient-${label.replace(/[^a-z0-9-]/gi, "-")}`);
  materializeAmbientProbeFixture(ambientProbeSource, dir, lib, types, devDeps);

  const installResult = npmInstall(dir);
  if (installResult.status !== 0) {
    infrastructureFailures.push(
      `Ambient control "${label}" install failed (npm exit ${installResult.status}).`,
    );
    return { label, bunUnresolved: false, workersUnresolved: false };
  }

  const tscResult = typecheck(dir);
  const diagnostics = parseDiagnostics(tscResult.stdout + tscResult.stderr);

  const bunUnresolved = diagnostics.some(
    (d) =>
      d.origin === "consumer-authored" &&
      /\bBun\b/.test(d.message) &&
      /Cannot find name/.test(d.message),
  );
  const workersUnresolved = diagnostics.some(
    (d) =>
      d.origin === "consumer-authored" &&
      /WebSocketPair/.test(d.message) &&
      /Cannot find name/.test(d.message),
  );

  return { label, bunUnresolved, workersUnresolved };
}

const nodeOnlyAmbient = runAmbientControl("node-only", caseB.lib, caseB.types, {});
const fullProvidersAmbient = runAmbientControl(
  "bun-workers-activated",
  caseDFull.lib,
  caseDFull.types,
  {
    "@types/bun": FIXED_VERSIONS.typesBun,
    "bun-types": FIXED_VERSIONS.bunTypes,
    "@cloudflare/workers-types": FIXED_VERSIONS.cloudflareWorkersTypes,
  },
);

if (!nodeOnlyAmbient.bunUnresolved || !nodeOnlyAmbient.workersUnresolved) {
  selfTestFailures.push(
    "Node-only ambient control did not reject Bun/WebSocketPair as unresolved names; the negative control is broken.",
  );
}
if (fullProvidersAmbient.bunUnresolved || fullProvidersAmbient.workersUnresolved) {
  selfTestFailures.push(
    "Bun/Workers-activated ambient control still reports Bun/WebSocketPair as unresolved; the positive contrast fixture is broken.",
  );
}

// --- AC5 disposable self-tests ----------------------------------------------
const mismatchDir = join(tmpRoot, "mismatch-control");
materializeH3OnlyFixture(mismatchControlSource, mismatchDir, caseB);
const mismatchInstall = npmInstall(mismatchDir);
let mismatchControl: MismatchControlResult = { found: false, origin: null, code: null };

if (mismatchInstall.status !== 0) {
  infrastructureFailures.push(
    `Mismatch control install failed (npm exit ${mismatchInstall.status}).`,
  );
} else {
  const mismatchTsc = typecheck(mismatchDir);
  const mismatchDiagnostics = parseDiagnostics(mismatchTsc.stdout + mismatchTsc.stderr);
  const found = mismatchDiagnostics.find(
    (d) => d.origin === "consumer-authored" && d.code === "TS2322",
  );
  mismatchControl = { found: !!found, origin: found?.origin ?? null, code: found?.code ?? null };
}

if (!mismatchControl.found) {
  selfTestFailures.push(
    "AC5 mismatch control: deliberate consumer-authored type error (TS2322) was not detected/classified correctly.",
  );
}

const versionMismatchDir = join(tmpRoot, "version-mismatch-control");
mkdirSync(versionMismatchDir, { recursive: true });
writeFileSync(
  join(versionMismatchDir, "package.json"),
  `${JSON.stringify(
    {
      name: "version-mismatch-control",
      private: true,
      version: "0.0.0",
      dependencies: { h3: "0.0.0-spec002-does-not-exist" },
    },
    null,
    2,
  )}\n`,
);
const versionMismatchInstall = npmInstall(versionMismatchDir);
const versionMismatchControl: VersionMismatchControlResult = {
  installFailedAsExpected: versionMismatchInstall.status !== 0,
};

if (!versionMismatchControl.installFailedAsExpected) {
  selfTestFailures.push(
    "Dependency-version-mismatch control: installing a nonexistent h3 version unexpectedly succeeded.",
  );
}

// --- Report + cleanup --------------------------------------------------------
const pnpmVersion = run("pnpm", ["--version"]).stdout.trim();
const npmVersion = run("npm", ["--version"]).stdout.trim();

const report = renderReport({
  generatedAt: new Date().toISOString(),
  baselineCommit: run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim(),
  versions: { node: process.version, pnpmVersion, npmVersion },
  cases: caseResults,
  ambientControls: [nodeOnlyAmbient, fullProvidersAmbient],
  mismatchControl,
  versionMismatchControl,
  selfTestFailures,
  infrastructureFailures,
  promotedCandidate,
});

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, report);

const prettierBin = join(repoRoot, "node_modules", ".bin", "prettier");
if (existsSync(prettierBin)) {
  run(prettierBin, ["--write", reportPath]);
}

console.log(`[test:consumer:types] Report written to ${reportPath}`);
console.log(
  `[test:consumer:types] Verdict: ${promotedCandidate ? `eligible candidate ${promotedCandidate}` : "upstream-blocked (no eligible candidate)"}`,
);

const ok = selfTestFailures.length === 0 && infrastructureFailures.length === 0;

if (ok) {
  rmSync(tmpRoot, { recursive: true, force: true });
  console.log("[test:consumer:types] All runner self-tests passed. Temporary workspace removed.");
  process.exit(0);
} else {
  for (const failure of [...infrastructureFailures, ...selfTestFailures]) {
    console.error(`[test:consumer:types] BLOCKED: ${failure}`);
  }
  console.error(`[test:consumer:types] Temporary workspace left for inspection: ${tmpRoot}`);
  process.exit(1);
}
