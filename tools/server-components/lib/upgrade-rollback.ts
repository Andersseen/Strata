import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";
import { TUPLE_PACKAGES, resolveTuple } from "../../release/lib/registry-tuple.ts";
import type { TuplePackage, VersionTuple } from "../../release/lib/registry-tuple.ts";

import { sanitize } from "./deployment-skew.ts";

/**
 * Helpers of `pnpm test:full-stack-registry-upgrade-rollback`
 * (docs/research/full-stack-registry-upgrade-rollback.md): two published Strata package
 * combinations, each installed from npm into its own external consumer and built on its own.
 * Private to the repo.
 */

export type Side = "a" | "b";

/**
 * Release A → release B. The default pair is the latest two published server-components minors
 * on the latest published core and analog (0.12.0 → 0.13.0 until 2026-11-05; see the M5 report).
 * `@strata-sc/analog` 0.12.1 is not published, so no pair can contain it yet.
 */
export const DEFAULT_PAIR: Readonly<Record<Side, VersionTuple>> = {
  a: {
    "@strata-sc/core": "0.2.2",
    "@strata-sc/analog": "0.12.0",
    "@strata-sc/server-components": "0.13.0",
  },
  b: {
    "@strata-sc/core": "0.2.2",
    "@strata-sc/analog": "0.12.0",
    "@strata-sc/server-components": "0.14.0",
  },
};

/**
 * Application deployment identities. They are labels of two DEPLOYMENTS, never derived from a
 * package version: a redeploy with identical packages is still a different build.
 */
export const DEFAULT_BUILD_IDS: Readonly<Record<Side, string>> = {
  a: "upgrade-a-2026.11.5",
  b: "upgrade-b-2026.11.6",
};

const SUFFIX: Readonly<Record<TuplePackage, string>> = {
  "@strata-sc/core": "CORE",
  "@strata-sc/analog": "ANALOG",
  "@strata-sc/server-components": "SERVER_COMPONENTS",
};

/** `STRATA_UPGRADE_A_CORE_VERSION` … `STRATA_UPGRADE_B_SERVER_COMPONENTS_VERSION`. */
export const pairEnvName = (side: Side, name: TuplePackage): string =>
  `STRATA_UPGRADE_${side.toUpperCase()}_${SUFFIX[name]}_VERSION`;

/** Exact versions only; an explicit input wins over the default and a tag or range is refused. */
export function selectedPair(env: NodeJS.ProcessEnv): Record<Side, VersionTuple> {
  const pick = (side: Side): VersionTuple =>
    resolveTuple(
      Object.fromEntries(TUPLE_PACKAGES.map((name) => [name, env[pairEnvName(side, name)]])),
      DEFAULT_PAIR[side],
    );

  return { a: pick("a"), b: pick("b") };
}

export function selectedBuildIds(env: NodeJS.ProcessEnv): Record<Side, string> {
  return {
    a: env["STRATA_UPGRADE_A_BUILD_ID"] ?? DEFAULT_BUILD_IDS.a,
    b: env["STRATA_UPGRADE_B_BUILD_ID"] ?? DEFAULT_BUILD_IDS.b,
  };
}

/** The runtime's own pattern for a build id (`packages/server-components/src/runtime/build-identity.ts`). */
export const isValidBuildId = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/.test(value);

/** One digest over a directory: the sorted relative paths and the bytes of every file. */
export function treeDigest(
  directory: string,
  skip: (file: string) => boolean = () => false,
): string {
  const hash = createHash("sha256");

  for (const file of listFiles(directory)
    .filter((f) => !skip(f))
    .sort()) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(directory, file)));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export const fileDigest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Builds the CURRENT sources of an installed consumer with `vite build` and keeps `dist/`
 * beside a link to that consumer's `node_modules`, enough to run it. The sources are never
 * edited: what differs between two releases is the installed Strata package set and the
 * build id the build is given.
 */
export function buildInstalledRelease(options: {
  readonly consumerDir: string;
  readonly releasesDir: string;
  readonly name: string;
  readonly buildId: string;
  readonly preset: "node" | "cloudflare";
  readonly env: NodeJS.ProcessEnv;
}): { readonly name: string; readonly directory: string; readonly output: string } {
  const { consumerDir, releasesDir, name, buildId, preset, env } = options;

  for (const dir of ["dist", "src/generated", ".nitro", ".angular"]) {
    rmSync(join(consumerDir, dir), { recursive: true, force: true });
  }

  const result = run(
    process.execPath,
    [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"],
    {
      cwd: consumerDir,
      env: {
        ...env,
        STRATA_STABLE_ENTRY: "1",
        STRATA_BUILD_ID: buildId,
        VITE_STRATA_UPGRADE_PROBES: "1",
        ...(preset === "cloudflare" ? { BUILD_PRESET: "cloudflare-pages" } : {}),
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `build of ${name} (${preset}) failed:\n${sanitize(result.stderr || result.stdout).slice(-3000)}`,
    );
  }

  const directory = join(releasesDir, `${preset}-${name}`);

  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  cpSync(join(consumerDir, "dist"), join(directory, "dist"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  symlinkSync(join(consumerDir, "node_modules"), join(directory, "node_modules"), "dir");

  return { name, directory, output: sanitize(result.stdout) };
}

// ---------------------------------------------------------------------------
// Browser observation of the full-stack fixture's `/products/42` and `/pair` pages

export interface Observed {
  readonly hosts: number;
  readonly hydratedHosts: number;
  readonly errors: readonly {
    name: string;
    category: string | null;
    recovery: string | null;
    message: string;
  }[];
  readonly mismatches: readonly { browserBuildId: string; serverBuildId: string }[];
  readonly hydrationObservations: readonly {
    outcome: string;
    discoveredBoundaries: number;
    committedBoundaries: number;
    failureCategory?: string;
    buildMismatch: boolean;
    recoveryOutcome?: string;
  }[];
  readonly record: string | null;
  readonly sameNodes: boolean;
  readonly unhandled: readonly string[];
  readonly titles: readonly string[];
  readonly statuses: readonly string[];
}

export const OBSERVE = `(() => {
  const hosts = [...document.querySelectorAll("product-details")];
  let record = null;
  try { record = sessionStorage.getItem("strata:skew-recovery"); } catch { record = "(unavailable)"; }
  const nodes = window.__ssrNodes ?? [];
  const now = [...document.querySelectorAll("product-availability button[data-product-id]")];
  return {
    hosts: hosts.length,
    hydratedHosts: hosts.filter((host) => host.querySelector("[data-strata-hydrated]")).length,
    errors: window.__strataErrors ?? [],
    mismatches: window.__strataMismatches ?? [],
    hydrationObservations: window.__STRATA_HYDRATION_OBSERVATIONS__ ?? [],
    record,
    sameNodes: nodes.length > 0 && nodes.length === now.length && nodes.every((n, i) => n === now[i] && n.isConnected),
    unhandled: window.__unhandled ?? [],
    titles: hosts.map((host) => host.querySelector("h1")?.textContent ?? ""),
    statuses: hosts.map((host) => host.querySelector("product-availability output")?.textContent ?? ""),
  };
})()`;

/** Tags the SSR nodes before hydration and records unhandled rejections for the whole document. */
export const INIT_SCRIPT = `
  document.addEventListener("readystatechange", () => {
    if (document.readyState === "interactive") {
      window.__ssrNodes = [...document.querySelectorAll("product-availability button[data-product-id]")];
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    (window.__unhandled ??= []).push(String(event.reason?.message ?? event.reason));
  });`;
