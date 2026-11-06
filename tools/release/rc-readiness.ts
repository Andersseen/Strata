import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { planDistTags } from "./lib/dist-tags.ts";
import { readManifest, REGISTRY_PACKAGES } from "./lib/packages.ts";
import { assessRc, ledgerProblems } from "./lib/rc-readiness.ts";
import type { EvidenceLedger } from "./lib/rc-readiness.ts";
import { createAuthoritativeReader } from "./lib/registry.ts";
import type { RegistryReader } from "./lib/registry.ts";
import { classifyRelease, countChangesets } from "./lib/release-state.ts";

/**
 * `pnpm release:rc:check`: can 1.0.0-rc.0 be proposed now? Reads the live registry (read-only), the
 * frozen candidate, the Changesets and the evidence ledger, and prints the verdict with blockers
 * ranked by impact. Exits 1 on NO-GO, so it can gate a manual release.
 *
 *   --report               print the verdict and exit 0 (the Extended job: NO-GO is a state, not an error)
 *   --prerelease-dry-run   also rehearse the Changesets prerelease flow in a throwaway clone
 *
 * The rehearsal runs `changeset pre enter`, `changeset version` and `changeset pre exit` only, in a
 * clone with no remote and with no npm or GitHub credentials in its environment. It cannot publish,
 * tag or push: `changeset publish` is never invoked. It proves the commands in
 * docs/specs/004-first-release-candidate.md produce the intended versions and that a stable 1.0.0
 * is refused.
 */

const args = new Set(process.argv.slice(2));

for (const arg of args) {
  if (arg !== "--report" && arg !== "--prerelease-dry-run") {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NAMES = REGISTRY_PACKAGES.map(({ name }) => name);

async function rehearsePrerelease(): Promise<string[]> {
  const problems: string[] = [];
  const expect = (label: string, passed: boolean, detail = "") => {
    console.log(`${passed ? "  ok  " : " FAIL "} ${label}${passed ? "" : ` — ${detail}`}`);
    if (!passed) problems.push(label);
  };
  const dir = mkdtempSync(join(tmpdir(), "strata-rc-rehearsal-"));
  const clone = join(dir, "repo");
  const { NPM_TOKEN: _npm, NODE_AUTH_TOKEN: _node, GITHUB_TOKEN: _gh, ...base } = process.env;
  const env = { ...base, CI: "true" };

  try {
    execFileSync("git", ["clone", "--quiet", repoRoot, clone]);
    execFileSync("git", ["remote", "remove", "origin"], { cwd: clone });
    symlinkSync(join(repoRoot, "node_modules"), join(clone, "node_modules"));

    const changeset = (...command: string[]) =>
      execFileSync(
        process.execPath,
        [join(repoRoot, "node_modules", "@changesets", "cli", "bin.js"), ...command],
        { cwd: clone, env, stdio: "pipe" },
      );
    const versions = () =>
      REGISTRY_PACKAGES.map(({ dir: pkgDir }) => readManifest(join(clone, pkgDir)).version);
    const manifests = () =>
      REGISTRY_PACKAGES.map(({ dir: pkgDir }) => readManifest(join(clone, pkgDir)));
    const write = (name: string, body: string) =>
      writeFileSync(join(clone, ".changeset", name), body);
    const missing: RegistryReader = () => Promise.resolve({ status: "missing" });
    const classify = (stableAuthorized = false) =>
      classifyRelease({
        changesets: countChangesets(join(clone, ".changeset")),
        packages: manifests(),
        readRegistry: missing,
        stableAuthorized,
      });

    // The RC-entry commit of the spec: one fixed version line, and a major for every package.
    const configPath = join(clone, ".changeset", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, fixed: [NAMES] }, null, 2));
    write(
      "rc-entry.md",
      `---\n${NAMES.map((name) => `"${name}": major`).join("\n")}\n---\n\nFirst release candidate.\n`,
    );

    changeset("pre", "enter", "rc");
    changeset("version");
    expect(
      "`changeset pre enter rc` + `version`: one tuple, all three at 1.0.0-rc.0",
      versions().every((version) => version === "1.0.0-rc.0"),
      versions().join(", "),
    );

    const first = countChangesets(join(clone, ".changeset"));
    expect(
      "the consumed Changesets no longer read as pending",
      first.nonEmpty === 0,
      JSON.stringify(first),
    );

    const decision = await classify();
    expect(
      "the Release classifier publishes rc.0 instead of versioning again",
      decision.state === "PUBLISH_REQUIRED",
      decision.reason,
    );
    expect(
      "dist-tags: `next` moves to the RC, `latest` is never touched",
      JSON.stringify(
        planDistTags({ latest: "0.16.0", next: "0.16.0", rc: "1.0.0-rc.0" }, "1.0.0-rc.0"),
      ) === JSON.stringify([{ tag: "next", from: "0.16.0", to: "1.0.0-rc.0" }]),
    );

    write("rc-fix.md", `---\n"${NAMES[1]}": patch\n---\n\nFix.\n`);
    changeset("version");
    expect(
      "a fix to one package supersedes the whole tuple: all three at 1.0.0-rc.1",
      versions().every((version) => version === "1.0.0-rc.1"),
      versions().join(", "),
    );

    changeset("pre", "exit");
    changeset("version");
    expect(
      "`changeset pre exit` + `version` would produce stable 1.0.0",
      versions().every((version) => version === "1.0.0"),
      versions().join(", "),
    );
    const stable = await classify();
    expect(
      "that stable 1.0.0 is BLOCKED without the explicit authorization",
      stable.state === "BLOCKED" && /STRATA_RELEASE_STABLE_1_0/.test(stable.reason),
      stable.reason,
    );
    expect(
      "with the authorization it would publish (not exercised beyond classification)",
      (await classify(true)).state === "PUBLISH_REQUIRED",
    );

    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ledger = JSON.parse(
  readFileSync(join(repoRoot, "tools", "release", "rc-evidence.json"), "utf8"),
) as EvidenceLedger;
const invalid = ledgerProblems(ledger);

if (invalid.length > 0) {
  console.error(`invalid evidence ledger:\n- ${invalid.join("\n- ")}`);
  process.exit(2);
}

const frozen = JSON.parse(
  readFileSync(join(repoRoot, "tests", "full-stack-candidate", "candidate.json"), "utf8"),
) as { id: string; strata: Record<string, { version: string }> };

const assessment = await assessRc({
  ledger,
  packages: REGISTRY_PACKAGES.map(({ dir }) => readManifest(join(repoRoot, dir))),
  frozenTuple: Object.fromEntries(
    Object.entries(frozen.strata).map(([name, { version }]) => [name, version]),
  ),
  pendingChangesets: countChangesets(join(repoRoot, ".changeset")).nonEmpty,
  readRegistry: createAuthoritativeReader(),
});

let rehearsal: string[] = [];

if (args.has("--prerelease-dry-run")) {
  console.log("\nChangesets prerelease rehearsal (throwaway clone, no remote, no credentials)");
  rehearsal = await rehearsePrerelease();
}

console.log(`\nRC target ${ledger.target}, candidate ${ledger.candidate}, frozen ${frozen.id}`);
console.log(`VERDICT: ${assessment.verdict}`);
assessment.blockers.forEach(({ id, reason }, index) => {
  console.log(`  ${index + 1}. ${id}: ${reason}`);
});
if (assessment.accepted.length > 0) {
  console.log("Accepted for an RC (never for General Availability without new evidence):");
  for (const { id, status, note } of assessment.accepted)
    console.log(`  - ${id} [${status}]: ${note}`);
}

if (rehearsal.length > 0) {
  console.error(`prerelease rehearsal FAILED:\n- ${rehearsal.join("\n- ")}`);
  process.exitCode = 1;
} else if (assessment.verdict === "NO-GO" && !args.has("--report")) {
  process.exitCode = 1;
}
