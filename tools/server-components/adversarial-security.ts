import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../consumer/lib/exec.ts";

import {
  AUTHORIZATION_MUTATION,
  BROWSER_CONFIDENTIALITY_MUTATION,
  DATA_SUBSTITUTION_MUTATION,
  classifyMutationRun,
  cleanupTemporaryDirectory,
  copyAndMutateFixture,
  digestSource,
} from "./lib/adversarial-mutations.ts";
import type { SourceMutation } from "./lib/adversarial-mutations.ts";
import { fixtureTemplate } from "./lib/full-stack-install.ts";
import { check, repoRoot, section } from "./lib/harness.ts";
import { snapshotDir } from "./lib/package-consumer.ts";

const original = snapshotDir(fixtureTemplate, () => false);
const root = mkdtempSync(join(tmpdir(), "strata-adversarial-security-"));
const outcomes: { name: string; expectedFailure: string; sourceDigest: string }[] = [];
let failed = false;
let reuseRoot = process.env["STRATA_ADVERSARIAL_REUSE_ROOT"];
let ownsReuseRoot = false;

try {
  if (reuseRoot) {
    const validSeed =
      existsSync(join(reuseRoot, "tarballs")) &&
      existsSync(join(reuseRoot, "consumer", "package-lock.json")) &&
      existsSync(join(reuseRoot, "consumer", "node_modules")) &&
      existsSync(join(reuseRoot, "consumer-ts59", "package-lock.json")) &&
      existsSync(join(reuseRoot, "consumer-ts59", "node_modules"));
    failed ||= !check(
      "reuse one healthy, externally installed packed-package tuple",
      validSeed,
      reuseRoot,
    );
  } else {
    section("Prepare one healthy packed install for all independent source variants");
    const healthyEnv = { ...process.env, STRATA_KEEP_CONSUMER: "1" };
    for (const key of [
      "STRATA_FULL_STACK_FIXTURE",
      "STRATA_ADVERSARIAL_SOURCE_PATH",
      "STRATA_ADVERSARIAL_SOURCE_DIGEST",
      "STRATA_ADVERSARIAL_REUSE_ROOT",
    ])
      delete healthyEnv[key];
    const healthy = run(
      process.execPath,
      [
        "--experimental-strip-types",
        join(repoRoot, "tools/server-components/full-stack-consumer.ts"),
      ],
      { cwd: repoRoot, env: healthyEnv },
    );
    const healthyTranscript = `${healthy.stdout}\n${healthy.stderr}`;
    reuseRoot = healthyTranscript.match(/^kept: (.+)$/m)?.[1];
    const healthyPassed =
      healthy.status === 0 &&
      healthyTranscript.includes("ok   external packed-package installation") &&
      !!reuseRoot;
    check(
      "healthy external packed consumer is a valid shared package/install seed",
      healthyPassed,
      healthyPassed ? reuseRoot : healthyTranscript.split("\n").slice(-24).join("\n"),
    );
    failed ||= !healthyPassed;
    ownsReuseRoot = healthyPassed;
  }

  const allScenarios: {
    mutation: SourceMutation;
    expectedFailure: string;
    expectedMarker?: string;
  }[] = [
    {
      mutation: AUTHORIZATION_MUTATION,
      expectedFailure: "protected controller enforces tenant ownership",
    },
    {
      mutation: DATA_SUBSTITUTION_MUTATION,
      expectedFailure: "protected controller enforces tenant ownership",
    },
    {
      mutation: BROWSER_CONFIDENTIALITY_MUTATION,
      expectedFailure:
        "ALPHA_CONFIDENTIAL_71c1: absent from every browser file, source map included",
      expectedMarker: "ALPHA_CONFIDENTIAL_71c1",
    },
  ];
  const scenarios = process.argv.includes("--smoke") ? allScenarios.slice(0, 1) : allScenarios;
  const selectedScenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
  const selectedScenarios = selectedScenario
    ? scenarios.filter(({ mutation }) =>
        selectedScenario === "authorization"
          ? mutation === AUTHORIZATION_MUTATION
          : selectedScenario === "data"
            ? mutation === DATA_SUBSTITUTION_MUTATION
            : selectedScenario === "browser"
              ? mutation === BROWSER_CONFIDENTIALITY_MUTATION
              : false,
      )
    : scenarios;
  if (selectedScenario && selectedScenarios.length !== 1) {
    check(
      "requested adversarial scenario is recognized",
      false,
      `unknown scenario: ${selectedScenario}; use authorization, data, or browser`,
    );
    failed = true;
  }

  for (const [index, scenario] of (reuseRoot && !failed ? selectedScenarios : []).entries()) {
    section(`Adversarial source build ${index + 1}: ${scenario.mutation.name}`);
    const fixture = join(root, `fixture-${index + 1}`);
    const sourcePath = join(fixture, scenario.mutation.path);
    const before = readFileSync(join(fixtureTemplate, scenario.mutation.path), "utf8");
    const digest = copyAndMutateFixture(fixtureTemplate, fixture, scenario.mutation);

    failed ||= !check(
      `${scenario.mutation.name}: source digest changed`,
      digest !== digestSource(before),
    );
    failed ||= !check(
      `${scenario.mutation.name}: source has intended fault`,
      readFileSync(sourcePath, "utf8").includes(scenario.mutation.after),
    );
    outcomes.push({
      name: scenario.mutation.name,
      expectedFailure: scenario.expectedFailure,
      sourceDigest: digest,
    });

    const result = run(
      process.execPath,
      [
        "--experimental-strip-types",
        join(repoRoot, "tools/server-components/full-stack-consumer.ts"),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          STRATA_FULL_STACK_FIXTURE: fixture,
          STRATA_FULL_STACK_REUSE_ROOT: reuseRoot,
          STRATA_KEEP_CONSUMER: "1",
          STRATA_ADVERSARIAL_SOURCE_PATH: scenario.mutation.path,
          STRATA_ADVERSARIAL_SOURCE_DIGEST: digest,
        },
      },
    );
    const transcript = `${result.stdout}\n${result.stderr}`;
    const consumerRoot = transcript.match(/^kept: (.+)$/m)?.[1];
    const expectedMarker = scenario.expectedMarker;
    const markerArtifacts =
      expectedMarker && consumerRoot
        ? findContaining(join(consumerRoot, "consumer", "dist"), expectedMarker).filter(
            (path) => path.includes("/client/") || path.includes("/analog/public/"),
          )
        : [];
    const verdict = classifyMutationRun({
      status: result.status,
      transcript,
      expectedFailure: scenario.expectedFailure,
      sourceDigest: digest,
      expectedMarker: scenario.expectedMarker,
      markerInBrowserArtifact: markerArtifacts.length > 0,
    });
    console.log(`EXPECTED REJECTION: ${verdict.rejection ?? "none observed"}`);
    if (expectedMarker)
      check(
        `${scenario.mutation.name}: positive control, marker survived into browser artifact`,
        markerArtifacts.length > 0,
        markerArtifacts.join(", "),
      );
    if (expectedMarker && markerArtifacts.length > 0)
      console.log(`BROWSER POSITIVE CONTROL: ${expectedMarker} → ${markerArtifacts.join(", ")}`);
    check(
      `${scenario.mutation.name}: actual production consumer rejected the mutated behavior`,
      verdict.accepted,
      verdict.reasons.join("; ") ||
        transcript
          .split("\n")
          .filter((line) => line.includes("FAIL"))
          .join("\n")
          .slice(-2_000),
    );
    failed ||= !verdict.accepted;
    const preserveFailure = !verdict.accepted && process.env["STRATA_KEEP_CONSUMER"] === "1";
    if (preserveFailure) {
      writeFileSync(join(fixture, "consumer-run.log"), transcript);
      console.log(`unexpected failure diagnostics: ${fixture}`);
    } else {
      if (consumerRoot) cleanupTemporaryDirectory(consumerRoot);
      cleanupTemporaryDirectory(fixture);
    }
  }

  const originalFixtureUnchanged =
    JSON.stringify(original) === JSON.stringify(snapshotDir(fixtureTemplate, () => false));
  check(
    "the original consumer fixture is byte-identical after all variants",
    originalFixtureUnchanged,
  );
  failed ||= !originalFixtureUnchanged;
  console.log(
    `adversarial source digests: ${outcomes.map(({ name, sourceDigest }) => `${name}=${sourceDigest}`).join("; ")}`,
  );
} finally {
  if (failed && process.env["STRATA_KEEP_CONSUMER"] === "1")
    console.log(`adversarial failure artifacts kept: ${root}`);
  else cleanupTemporaryDirectory(root);
  if (ownsReuseRoot && reuseRoot) {
    if (failed && process.env["STRATA_KEEP_CONSUMER"] === "1")
      console.log(`shared package/install seed kept: ${reuseRoot}`);
    else cleanupTemporaryDirectory(reuseRoot);
  }
}

function findContaining(root: string, marker: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return findContaining(path, marker);
    try {
      return readFileSync(path, "utf8").includes(marker) ? [path] : [];
    } catch {
      return [];
    }
  });
}

if (failed) process.exitCode = 1;
