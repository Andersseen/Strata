import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKUMENT_PROPAGATION } from "./lib/dist-tags.ts";
import { readManifest, REGISTRY_PACKAGES } from "./lib/packages.ts";
import {
  createAuthoritativeReader,
  createRegistryReader,
  createTarballIntegrityReader,
} from "./lib/registry.ts";
import {
  classifyRelease,
  countChangesets,
  discardEmptyChangesets,
  verifyPublication,
  verifyPublicationEventually,
} from "./lib/release-state.ts";

/**
 * Release state for .github/workflows/release.yml (read-only registry access).
 *
 *   classify   decide VERSION_REQUIRED / PUBLISH_REQUIRED / ALREADY_PUBLISHED /
 *              BLOCKED, write them as step outputs and the job summary. Exits
 *              non-zero on BLOCKED. With --prepare, PUBLISH_REQUIRED also
 *              removes empty Changesets from the release checkout (never
 *              committed) so changesets/action runs its publish script.
 *   verify     COMMITTED: fail unless the uncached registry endpoints hold every
 *              public package at its exact manifest version with the right
 *              dependencies and dist-tags, a tarball matching its recorded
 *              integrity and, for the packages this run published (--published,
 *              comma-separated), a provenance attestation.
 *              PROPAGATED: then fail unless the CDN-cached packument `npm install`
 *              reads shows the same state, reported separately: that failure
 *              means "committed, not yet installable", never "republish".
 *              Tag and GitHub Release gaps for --published are warnings.
 *
 * Every decision reads the authoritative endpoints: a stale packument must not
 * make a committed version look unpublished.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--") && !arg.includes("=")));
const published = (rest.find((arg) => arg.startsWith("--published="))?.split("=")[1] ?? "")
  .split(",")
  .filter(Boolean);

const packages = REGISTRY_PACKAGES.map(({ dir }) => readManifest(join(repoRoot, dir)));
const readRegistry = createAuthoritativeReader();

function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(text: string): void {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function githubHas(path: string): Promise<boolean | undefined> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) return undefined;

  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return false;
  return response.ok ? true : undefined;
}

if (command === "classify") {
  const changesets = countChangesets(join(repoRoot, ".changeset"));
  const decision = await classifyRelease({
    changesets,
    packages,
    readRegistry,
    stableAuthorized: process.env["STRATA_RELEASE_STABLE_1_0"] === "authorized",
  });

  output("state", decision.state);
  output("unpublished", decision.unpublished.join(","));
  output(
    "server-components-unpublished",
    String(decision.unpublished.includes("@strata-sc/server-components")),
  );
  output(
    "server-components-version",
    packages.find(({ name }) => name === "@strata-sc/server-components")?.version ?? "",
  );
  summary(`### Release state: ${decision.state}\n${decision.reason}`);

  if (decision.state === "PUBLISH_REQUIRED" && flags.has("--prepare")) {
    discardEmptyChangesets(changesets.emptyFiles);
  }
  if (decision.state === "BLOCKED") {
    console.error(`::error::Release blocked: ${decision.reason}`);
    process.exitCode = 1;
  }
} else if (command === "verify") {
  // Bounded re-reads while a just-published version is not yet committed (Release runs
  // 42034642481 and 42181130222); any other problem, or one that persists, still fails.
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const verdict = await verifyPublicationEventually(
    () =>
      verifyPublication({
        packages,
        readRegistry,
        readTarballIntegrity: createTarballIntegrityReader(),
        requireProvenance: new Set(published),
      }),
    wait,
  );
  // Only meaningful once committed; the bound covers one full `max-age=300` CDN lifetime.
  const propagation = verdict.ok
    ? await verifyPublicationEventually(
        () => verifyPublication({ packages, readRegistry: createRegistryReader() }),
        wait,
        PACKUMENT_PROPAGATION,
      )
    : undefined;

  for (const name of published) {
    const version = packages.find((pkg) => pkg.name === name)?.version;
    const tag = encodeURIComponent(`${name}@${version}`);
    const hasTag = await githubHas(`/git/ref/tags/${tag}`);
    const hasRelease = await githubHas(`/releases/tags/${tag}`);
    if (hasTag === false) console.log(`::warning::git tag ${name}@${version} is missing`);
    if (hasRelease === false)
      console.log(`::warning::GitHub Release ${name}@${version} is missing`);
  }

  if (verdict.ok && propagation?.ok) {
    summary(
      `### Registry verification: PASS\nEvery public package is committed on npm at its manifest version (${verdict.attempts} read(s)) and visible to \`npm install\` (${propagation.attempts} read(s)).`,
    );
  } else if (verdict.ok) {
    const problems = propagation?.problems ?? [];
    summary(
      `### Registry verification: PROPAGATION LAG\nCommitted on npm, but the cached packument \`npm install\` reads is still behind:\n- ${problems.join("\n- ")}\n\nDo not republish. Re-run this job once the CDN catches up.`,
    );
    console.error(
      `::error::Propagation lag (committed, not yet installable):\n${problems.join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    summary(`### Registry verification: FAIL\n- ${verdict.problems.join("\n- ")}`);
    console.error(`::error::Registry verification failed:\n${verdict.problems.join("\n")}`);
    process.exitCode = 1;
  }
} else {
  console.error("Usage: release-state.ts classify [--prepare] | verify [--published=a,b]");
  process.exitCode = 2;
}
