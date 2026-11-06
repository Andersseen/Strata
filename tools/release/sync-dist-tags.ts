import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../consumer/lib/exec.ts";

import { awaitCompliantDistTags, awaitVersionVisible, planDistTags } from "./lib/dist-tags.ts";
import { readManifest, REGISTRY_PACKAGES } from "./lib/packages.ts";
import { createAuthoritativeReader } from "./lib/registry.ts";

/**
 * Brings the npm dist-tags of every registry package in line with the policy in
 * tools/release/lib/dist-tags.ts (ADR-005): the version in each package.json,
 * once it is on npm, is `latest` when stable or `next` when a prerelease, and
 * `next` is never left behind `latest`. Idempotent and never moves a tag
 * backwards. A version not on npm yet is skipped, EXCEPT a package this run
 * just published (`--published=a,b`): that one is re-read with a bounded backoff
 * and fails the step if it never becomes visible.
 *
 * Every read is the uncached registry state (tools/release/lib/registry.ts), so a
 * stale cached packument can neither hide a committed version nor plan a move from
 * an old tag. A registry that cannot be read fails the package; it is never "not
 * on npm".
 *
 * Runs in .github/workflows/release.yml after `changeset publish`, and before the
 * Version Packages step when Changesets are pending: a run that died between
 * publishing and aligning (42181130222) is repaired by whichever run comes next.
 * The step output `server-components-repaired` tells the workflow that such a
 * recovery happened, so the post-publish registry gate that run never reached
 * can still execute.
 *
 *   --dry-run          print the planned moves without changing the registry
 *   --published=a,b    packages this run expected `changeset publish` to publish
 *
 * STRATA_ACCEPTED_PACKAGES holds changesets/action's `publishedPackages` output.
 * A package in --published that npm never accepted fails at once, without spending
 * the visibility bound on something that cannot appear.
 */

const REGISTRY = "https://registry.npmjs.org/";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const justPublished = new Set(
  [...args]
    .find((arg) => arg.startsWith("--published="))
    ?.slice("--published=".length)
    .split(",")
    .filter(Boolean) ?? [],
);

for (const arg of args) {
  if (arg !== "--dry-run" && !arg.startsWith("--published=")) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const label = dryRun ? "[dist-tags:dry-run]" : "[dist-tags]";

function npm(npmArgs: readonly string[]) {
  return run("npm", [...npmArgs, "--registry", REGISTRY], { cwd: repoRoot });
}

const readRegistry = createAuthoritativeReader();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const acceptedJson = process.env["STRATA_ACCEPTED_PACKAGES"];
const accepted =
  acceptedJson === undefined || acceptedJson === ""
    ? undefined
    : new Set((JSON.parse(acceptedJson) as readonly { name: string }[]).map(({ name }) => name));

let failed = false;
const repaired: string[] = [];

for (const pkg of REGISTRY_PACKAGES) {
  const { name, version } = readManifest(join(repoRoot, pkg.dir));

  try {
    const lookup = () => readRegistry(name, version);
    const distTags = async () => {
      const state = await lookup();
      return state.status === "found" ? state.distTags : {};
    };
    const visible = async (): Promise<boolean> => {
      const state = await lookup();
      return state.status === "found" && version in state.versions;
    };

    if (justPublished.has(name)) {
      if (accepted && !accepted.has(name)) {
        throw new Error(
          `npm never accepted ${version}: changeset publish did not report it. This is a failed publish, not visibility lag.`,
        );
      }
      const reads = await awaitVersionVisible(visible, pause);
      console.log(`${label} ${name}@${version} committed on npm after ${reads} read(s).`);
    } else if (!(await visible())) {
      console.log(`${label} ${name}@${version} is not on npm; skipping.`);
      continue;
    }

    const changes = planDistTags(await distTags(), version);
    if (changes.length === 0) {
      console.log(`${label} ${name}@${version}: dist-tags already comply.`);
      continue;
    }

    for (const { tag, from, to } of changes) {
      console.log(`${label} ${name}: ${tag} ${from ?? "(absent)"} → ${to}`);
      if (dryRun) continue;

      const add = npm(["dist-tag", "add", `${name}@${to}`, tag]);
      if (add.status !== 0) throw new Error(`npm dist-tag add failed:\n${add.stderr}`);
    }

    if (!dryRun) {
      const { tags, attempts } = await awaitCompliantDistTags(distTags, version, pause);
      console.log(
        `${label} ${name} dist-tags (visible after ${attempts} read(s)): ${JSON.stringify(tags)}`,
      );
      if (!justPublished.has(name)) repaired.push(name);
    }
  } catch (error) {
    failed = true;
    console.error(
      `${label} ${name} FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (process.env["GITHUB_OUTPUT"]) {
  appendFileSync(
    process.env["GITHUB_OUTPUT"],
    `server-components-repaired=${repaired.includes("@strata-sc/server-components")}\n`,
  );
}

process.exitCode = failed ? 1 : 0;
