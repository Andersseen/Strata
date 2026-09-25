import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../consumer/lib/exec.ts";
import {
  assertPublishSelection,
  describeTarball,
  DIST_TAG,
  inspectTarball,
  packPackage,
  PUBLISHABLE_PACKAGES,
} from "./lib/packages.ts";

/**
 * Publishes the qualified packages (@strata-sc/core, @strata-sc/analog) to npm under
 * the `next` dist-tag. Never publishes @strata-sc/h3 or moves `latest`.
 *
 *   --dry-run     pack, inspect and `npm publish --dry-run`; scope preflight
 *                 problems are reported but do not fail the run
 *   --provenance  attach npm provenance (GitHub Actions with id-token: write)
 *
 * Packages must already be built. Each package is packed once with pnpm
 * (which rewrites `workspace:` ranges), inspected, and that exact tarball is
 * what gets published. Versions already on the registry are skipped, so a
 * partially failed release can be re-run.
 */

const SCOPE = "strata-sc";
const REGISTRY = "https://registry.npmjs.org/";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const provenance = args.has("--provenance");

for (const arg of args) {
  if (arg !== "--dry-run" && arg !== "--provenance") {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const label = dryRun ? "[release:dry-run]" : "[release]";

function npm(npmArgs: readonly string[]) {
  return run("npm", [...npmArgs, "--registry", REGISTRY], { cwd: repoRoot });
}

/**
 * Checks the authenticated npm identity can publish under @strata-sc. A missing
 * package on the registry says nothing about who owns the scope, so this
 * requires either the `strata` user itself or membership of the `strata` org.
 */
function scopePreflight(): string | null {
  const whoami = npm(["whoami"]);

  if (whoami.status !== 0) {
    return `npm auth blocker: \`npm whoami\` failed (${whoami.stderr.trim().split("\n")[0] ?? "no output"}).`;
  }

  const user = whoami.stdout.trim();

  if (user === SCOPE) {
    console.log(`${label} npm user "${user}" owns the @${SCOPE} user scope.`);
    return null;
  }

  const org = npm(["org", "ls", SCOPE, "--json"]);
  if (org.status === 0) {
    const members = JSON.parse(org.stdout || "{}") as Record<string, string>;
    const role = members[user];

    if (role) {
      console.log(`${label} npm user "${user}" is a member of the @${SCOPE} org (role: ${role}).`);
      return null;
    }
  }

  return `npm scope ownership blocker: npm user "${user}" is neither the "${SCOPE}" user nor a member of the "${SCOPE}" org.`;
}

function isPublished(name: string, version: string): boolean {
  const view = npm(["view", `${name}@${version}`, "version", "--json"]);

  return view.status === 0 && view.stdout.trim().length > 0;
}

const tarballDir = mkdtempSync(join(tmpdir(), "strata-release-"));
let failed = false;

try {
  assertPublishSelection(PUBLISHABLE_PACKAGES);
  console.log(
    `${label} packages: ${PUBLISHABLE_PACKAGES.map(({ name }) => name).join(", ")} → dist-tag "${DIST_TAG}"`,
  );

  const blocker = scopePreflight();
  if (blocker) {
    if (!dryRun) throw new Error(blocker);
    console.warn(`${label} WARNING (not fatal in dry-run): ${blocker}`);
  }

  for (const pkg of PUBLISHABLE_PACKAGES) {
    const inspection = inspectTarball(repoRoot, packPackage(repoRoot, pkg, tarballDir));
    const { name, version } = inspection.manifest;

    console.log(`\n${label} ${describeTarball(inspection)}`);
    if (inspection.problems.length > 0) {
      throw new Error(`${name} tarball failed inspection:\n- ${inspection.problems.join("\n- ")}`);
    }

    if (isPublished(name, version)) {
      console.log(`${label} ${name}@${version} is already on the registry; skipping.`);
      continue;
    }

    const publishArgs = ["publish", inspection.path, "--tag", DIST_TAG, "--access", "public"];
    if (provenance) publishArgs.push("--provenance");
    if (dryRun) publishArgs.push("--dry-run");

    const publish = npm(publishArgs);
    process.stdout.write(publish.stdout);
    process.stderr.write(publish.stderr);
    if (publish.status !== 0) throw new Error(`npm publish failed for ${name}@${version}.`);

    if (!dryRun) {
      const tags = JSON.parse(npm(["view", name, "dist-tags", "--json"]).stdout || "{}") as Record<
        string,
        string
      >;
      console.log(`${label} ${name} dist-tags: ${JSON.stringify(tags)}`);
      if (tags[DIST_TAG] !== version) {
        throw new Error(`${name} dist-tag "${DIST_TAG}" does not point at ${version}.`);
      }
    }
  }
} catch (error) {
  failed = true;
  console.error(`\n${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(tarballDir, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
