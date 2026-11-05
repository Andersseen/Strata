import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../consumer/lib/exec.ts";

import { awaitCompliantDistTags, awaitVersionVisible, planDistTags } from "./lib/dist-tags.ts";
import { readManifest, REGISTRY_PACKAGES } from "./lib/packages.ts";

/**
 * Brings the npm dist-tags of every registry package in line with the policy in
 * tools/release/lib/dist-tags.ts (ADR-005): the version in each package.json,
 * once it is on npm, is `latest` when stable or `next` when a prerelease, and
 * `next` is never left behind `latest`. Idempotent and never moves a tag
 * backwards. A version not on npm yet is skipped, EXCEPT a package this run
 * just published (`--published=a,b`): that one is re-read with a bounded backoff
 * and fails the step if it never becomes visible.
 *
 * Runs in .github/workflows/release.yml after `changeset publish`, which is
 * what repairs releases published before this policy.
 *
 *   --dry-run          print the planned moves without changing the registry
 *   --published=a,b    packages `changeset publish` just published (must become visible)
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

function distTags(name: string): Record<string, string> {
  // --prefer-online: revalidate npm's local metadata cache on every read.
  const view = npm(["view", name, "dist-tags", "--json", "--prefer-online"]);

  if (view.status !== 0) throw new Error(`npm view ${name} dist-tags failed:\n${view.stderr}`);

  return JSON.parse(view.stdout || "{}") as Record<string, string>;
}

let failed = false;

for (const pkg of REGISTRY_PACKAGES) {
  const { name, version } = readManifest(join(repoRoot, pkg.dir));

  try {
    const visible = (): boolean => {
      const view = npm(["view", `${name}@${version}`, "version", "--prefer-online"]);

      return view.status === 0 && view.stdout.trim() === version;
    };

    if (justPublished.has(name)) {
      const reads = await awaitVersionVisible(
        visible,
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      );
      console.log(`${label} ${name}@${version} visible on npm after ${reads} read(s).`);
    } else if (!visible()) {
      console.log(`${label} ${name}@${version} is not on npm; skipping.`);
      continue;
    }

    const changes = planDistTags(distTags(name), version);
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
      const { tags, attempts } = await awaitCompliantDistTags(
        () => distTags(name),
        version,
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      );
      console.log(
        `${label} ${name} dist-tags (visible after ${attempts} read(s)): ${JSON.stringify(tags)}`,
      );
    }
  } catch (error) {
    failed = true;
    console.error(
      `${label} ${name} FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

process.exitCode = failed ? 1 : 0;
