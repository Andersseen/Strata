import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { planDistTags } from "./lib/dist-tags.ts";
import { readManifest, REGISTRY_PACKAGES } from "./lib/packages.ts";
import { assessRc, candidateIdentity, LEDGER_PATH, onlyVersioning } from "./lib/rc-readiness.ts";
import { createGitFacts, createHostedReader } from "./lib/rc-sources.ts";
import { createAuthoritativeReader } from "./lib/registry.ts";
import type { RegistryReader } from "./lib/registry.ts";
import { classifyRelease, countChangesets, isEmptyChangeset } from "./lib/release-state.ts";

/**
 * `pnpm release:rc:check`: the RC authorization gate. It recomputes the candidate's identity from git,
 * re-reads every hosted proof from GitHub and every published artifact from npm, and prints the verdict
 * with blockers ranked by impact. Exits 1 on NO-GO.
 *
 *   --phase=pre            (default) may this candidate be published?
 *   --phase=post           are the exact published artifacts qualified?
 *   --publishing           on the Version Packages commit: allows the versioning diff from the candidate
 *   --print-candidate=SHA  print the ledger's `candidate` block for a commit and exit
 *   --report               print the verdict and exit 0. NOT an authorization: see the banner it prints
 *   --prerelease-dry-run   also rehearse the Changesets prerelease flow in a throwaway clone
 *
 * The rehearsal runs `changeset pre enter`, `changeset version` and `changeset pre exit` only, in a
 * clone with no remote and with no npm or GitHub credentials in its environment. It cannot publish,
 * tag or push: `changeset publish` is never invoked. It proves the commands in
 * docs/specs/004-first-release-candidate.md produce the intended versions and that a stable 1.0.0
 * is refused.
 */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => !arg.includes("=")));
const option = (name: string): string | undefined =>
  argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const KNOWN = ["--report", "--prerelease-dry-run", "--publishing", "--phase", "--print-candidate"];

for (const arg of argv) {
  if (!KNOWN.includes(arg.split("=")[0]!)) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const phase = option("--phase") ?? "pre";

if (phase !== "pre" && phase !== "post") {
  console.error(`Unknown phase: ${phase}`);
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NAMES = REGISTRY_PACKAGES.map(({ name }) => name);
const REPOSITORY = process.env["GITHUB_REPOSITORY"] ?? "Andersseen/Strata";
const MAINTAINER = "Andersseen";
const RC_ENTRY_CHANGESET = "rc-entry.md";

/**
 * Packs the versioned clone and installs the tarballs as a consumer would: the published shape of the
 * tuple, rather than its manifests in the workspace.
 */
function installedTuple(
  clone: string,
  dir: string,
  expect: (label: string, passed: boolean, detail?: string) => void,
): void {
  const tarballs = join(dir, "tarballs");
  const consumer = join(dir, "consumer");

  mkdirSync(tarballs);
  mkdirSync(consumer);

  for (const { dir: pkgDir } of REGISTRY_PACKAGES) {
    const built = join(repoRoot, pkgDir, "dist");

    if (!existsSync(built)) throw new Error(`the rehearsal needs built packages: no ${built}`);
    cpSync(built, join(clone, pkgDir, "dist"), { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", tarballs], {
      cwd: join(clone, pkgDir),
      stdio: "pipe",
    });
  }

  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "rc", private: true }));
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--loglevel=error",
      ...readdirSync(tarballs).map((file) => join(tarballs, file)),
    ],
    { cwd: consumer, stdio: "pipe", timeout: 120_000 },
  );

  const installed = NAMES.map(
    (name) =>
      JSON.parse(readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8")) as {
        version: string;
        dependencies?: Record<string, string>;
        exports?: Record<string, string | Record<string, string>>;
      },
  );
  const strataPins = installed.flatMap(({ dependencies = {} }) =>
    Object.entries(dependencies).filter(([name]) => name.startsWith("@strata-sc/")),
  );

  expect(
    "installed: all three tarballs are 1.0.0-rc.0",
    installed.every(({ version }) => version === "1.0.0-rc.0"),
    installed.map(({ version }) => version).join(", "),
  );
  expect(
    "installed: every Strata dependency is the exact RC, so no 0.x copy can join the tuple",
    strataPins.length > 0 && strataPins.every(([, range]) => range === "1.0.0-rc.0"),
    JSON.stringify(strataPins),
  );
  expect(
    "installed: exactly one copy of each package, none nested",
    !existsSync(join(consumer, "node_modules", "@strata-sc", "analog", "node_modules")),
  );

  const targets = installed.flatMap(({ exports = {} }, index) =>
    Object.values(exports).flatMap((target) =>
      (typeof target === "string" ? [target] : Object.values(target)).map((file) =>
        join(consumer, "node_modules", NAMES[index]!, file),
      ),
    ),
  );
  const missing = targets.filter((file) => !existsSync(file));

  expect(
    `installed: all ${targets.length} export targets exist`,
    targets.length > 0 && missing.length === 0,
    missing.join(", "),
  );
}

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
    // Changesets deepens a shallow clone forever when, as here, it has no remote.
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (shallow === "true") throw new Error("the rehearsal needs full history (fetch-depth: 0).");

    execFileSync("git", ["clone", "--quiet", repoRoot, clone]);
    execFileSync("git", ["remote", "remove", "origin"], { cwd: clone });
    symlinkSync(join(repoRoot, "node_modules"), join(clone, "node_modules"));

    const changeset = (...command: string[]) =>
      execFileSync(
        process.execPath,
        [join(repoRoot, "node_modules", "@changesets", "cli", "bin.js"), ...command],
        { cwd: clone, env, stdio: "pipe", timeout: 120_000 },
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

    const commit = (message: string): string => {
      const quiet = { cwd: clone, env, stdio: "pipe" } as const;
      const identity = ["-c", "user.name=rehearsal", "-c", "user.email=rehearsal@example.invalid"];

      execFileSync("git", ["add", "-A"], quiet);
      execFileSync(
        "git",
        [...identity, "commit", "--quiet", "--allow-empty", "-m", message],
        quiet,
      );

      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
    };

    changeset("pre", "enter", "rc");

    const entry = commit("rc entry");

    changeset("version");
    expect(
      "`changeset pre enter rc` + `version`: one tuple, all three at 1.0.0-rc.0",
      versions().every((version) => version === "1.0.0-rc.0"),
      versions().join(", "),
    );

    const versioned = commit("version packages");
    const facts = createGitFacts(clone);
    const changed = facts.changedPaths(entry, versioned) ?? [];

    expect(
      "the gate reads the Version Packages commit as versioning only",
      changed.length > 0 && onlyVersioning(changed, entry, versioned, facts),
      changed.join(", "),
    );
    installedTuple(clone, dir, expect);

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

    expect(
      "dist-tags: an aligned prerelease moves nothing, `latest` stays on the 0.x line",
      planDistTags({ latest: "0.17.0", next: "1.0.0-rc.0", rc: "1.0.0-rc.0" }, "1.0.0-rc.0")
        .length === 0,
    );

    write("rc-fix.md", `---\n"${NAMES[1]}": patch\n---\n\nFix.\n`);
    changeset("version");
    expect(
      "a fix to one package supersedes the whole tuple: all three at 1.0.0-rc.1",
      versions().every((version) => version === "1.0.0-rc.1"),
      versions().join(", "),
    );
    expect(
      "dist-tags: rc.1 moves `next` forward and never `latest`",
      JSON.stringify(
        planDistTags({ latest: "0.17.0", next: "1.0.0-rc.0", rc: "1.0.0-rc.1" }, "1.0.0-rc.1"),
      ) === JSON.stringify([{ tag: "next", from: "1.0.0-rc.0", to: "1.0.0-rc.1" }]),
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

const git = createGitFacts(repoRoot);
const printCandidate = option("--print-candidate");

if (printCandidate) {
  const identity = candidateIdentity(printCandidate, git, REGISTRY_PACKAGES);

  if (!identity) {
    console.error(`commit ${printCandidate} cannot be read`);
    process.exit(2);
  }
  console.log(JSON.stringify(identity, null, 2));
  process.exit(0);
}

const ledger = JSON.parse(readFileSync(join(repoRoot, LEDGER_PATH), "utf8")) as {
  target?: string;
  candidate?: { sha?: string } | null;
};
const changesetDir = join(repoRoot, ".changeset");
const entryPath = join(changesetDir, RC_ENTRY_CHANGESET);
const pendingEntry = existsSync(entryPath) && !isEmptyChangeset(readFileSync(entryPath, "utf8"));
const manifests = REGISTRY_PACKAGES.map(({ dir }) => readManifest(join(repoRoot, dir)));

const assessment = await assessRc({
  ledger,
  phase,
  publishing: flags.has("--publishing"),
  repository: REPOSITORY,
  maintainer: MAINTAINER,
  packageNames: NAMES,
  manifestVersions: Object.fromEntries(manifests.map(({ name, version }) => [name, version])),
  // The RC-entry Changeset is the plan for the candidate itself, not source no tuple contains.
  pendingChangesets: countChangesets(changesetDir).nonEmpty - (pendingEntry ? 1 : 0),
  git,
  hosted: createHostedReader(REPOSITORY, process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"]),
  readRegistry: createAuthoritativeReader(),
});

let rehearsal: string[] = [];

if (flags.has("--prerelease-dry-run")) {
  console.log("\nChangesets prerelease rehearsal (throwaway clone, no remote, no credentials)");
  rehearsal = await rehearsePrerelease();
}

console.log(
  `\nRC target ${ledger.target}, phase ${phase}, candidate ${ledger.candidate?.sha ?? "(not frozen)"}`,
);
if (flags.has("--report")) {
  console.log("REPORT ONLY: this run's exit status authorizes nothing. Only the verdict does.");
}
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
} else if (assessment.verdict === "NO-GO" && !flags.has("--report")) {
  process.exitCode = 1;
}
