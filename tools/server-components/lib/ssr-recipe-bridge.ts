import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./harness.ts";

/**
 * Registry and frozen-candidate modes of the full-stack qualification install a PUBLISHED tuple.
 * `@strata-sc/server-components` gained the opt-in `/ssr` entry in {@link SSR_ENTRY_SINCE}; an older
 * published tuple cannot import it. For such a tuple the run applies the consumer-owned recipe
 * (tests/full-stack-package-consumer/recipes/ssr-failure-contract.ts, same names and behaviour) and the
 * same SSR failure checks run against it. The packed (mandatory) qualification never bridges, and the
 * runner proves a bridged install really lacks the entry, so the bridge cannot hide the package API.
 */
export const SSR_ENTRY_SINCE = "0.15.0";

const RECIPE = join(
  repoRoot,
  "tests",
  "full-stack-package-consumer",
  "recipes",
  "ssr-failure-contract.ts",
);
const BRIDGED_RECIPE = join("src", "ssr-failure-contract.ts");
const SPECIFIER = '"@strata-sc/server-components/ssr"';
const EXAMPLE = "src/check/ssr-failure-example.ts";
const ANALOG_EXAMPLE = "src/check/ssr-failure-analog.ts";

/** `provideStrataSsrFailureHandler` returns `EnvironmentProviders`, and `integration` exists. */
export const SSR_PROTOCOL_SINCE = "0.17.0";

/** `@strata-sc/analog` shipped S-1 (`publicOrigin`) and S-2 (`ControllerConstructor`) in 0.13.0. */
export const ANALOG_CONTRACT_SINCE = "0.13.0";

const parts = (version: string): number[] =>
  version
    .split("-")[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10));

/**
 * Semver precedence on the release triple, where a prerelease precedes its own release
 * (`0.13.0-rc.0` predates `0.13.0`) and follows every earlier triple (`1.0.0-rc.0` does not predate
 * `0.17.0`).
 */
export function predates(version: string, since: string): boolean {
  const [a, b, c] = parts(version);
  const [x, y, z] = parts(since);

  if (a !== x || b !== y || c !== z) {
    return a! !== x! ? a! < x! : b! !== y! ? b! < y! : c! < z!;
  }

  return version.includes("-") && !since.includes("-");
}

/** Whether an exact published version predates the `/ssr` entry. */
export const predatesSsrEntry = (version: string): boolean => predates(version, SSR_ENTRY_SINCE);

/** Whether a version predates the 0.17.0 `/ssr` types, so the migration check cannot apply. */
export const predatesSsrProtocol = (version: string): boolean =>
  predates(version, SSR_PROTOCOL_SINCE);

/**
 * Whether an installed `@strata-sc/analog` exports the S-1/S-2 contract (`ControllerConstructor`,
 * the factory-typed overload, `publicOrigin`). Read from its declarations: a source-packed candidate
 * still carries the previous manifest version until Release applies its Changeset, and the published
 * 0.12.1 baseline lacks the contract.
 */
export function analogDeclaresConstructorContract(packageDir: string): boolean {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    types?: string;
    exports?: { ".": { types?: string } };
  };
  const entry = manifest.exports?.["."]?.types ?? manifest.types;
  if (!entry) return false;
  const declarations = readFileSync(join(packageDir, entry), "utf8");
  return (
    /\bControllerConstructor\b/.test(declarations) &&
    /\bpublicOrigin\b/.test(readDeclarationTree(packageDir, entry))
  );
}

export interface AnalogContractPresence {
  readonly version: string;
  /** The installed declarations carry S-1/S-2. */
  readonly declared: boolean;
  /** The installed version is 0.13.0 or later (prereleases included), so it must carry them. */
  readonly required: boolean;
}

/**
 * What the installed `@strata-sc/analog` declares, and whether its version obliges it to. A published
 * tuple at 0.13.0 or later (1.0.0-rc.0 included) that lacks the contract is a defect, never a
 * reason to skip S-1: only a tuple that predates 0.13.0 may run without it.
 */
export function installedAnalogContract(packageDir: string): AnalogContractPresence {
  const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    version: string;
  };

  return {
    version,
    declared: analogDeclaresConstructorContract(packageDir),
    required: !predates(version, ANALOG_CONTRACT_SINCE),
  };
}

/** Whether a published run may proceed without S-1/S-2: only when the version predates them. */
export const analogContractSatisfied = ({ declared, required }: AnalogContractPresence): boolean =>
  declared || !required;

function readDeclarationTree(packageDir: string, entry: string): string {
  const dir = join(packageDir, entry, "..");
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".d.ts"))
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .join("\n");
}

/** Rewrites the fixture copy to the consumer-owned recipe. Returns the touched files. */
export function applySsrRecipeBridge(consumerDir: string): string[] {
  cpSync(RECIPE, join(consumerDir, BRIDGED_RECIPE));
  const touched = [BRIDGED_RECIPE];

  for (const [file, relative] of [
    ["src/main.server.ts", '"./ssr-failure-contract"'],
    ["src/app/app.config.server.ts", '"../ssr-failure-contract"'],
  ] as const) {
    const path = join(consumerDir, file);
    const source = readFileSync(path, "utf8");

    if (!source.includes(SPECIFIER)) throw new Error(`${file} no longer imports ${SPECIFIER}`);
    writeFileSync(path, source.replaceAll(SPECIFIER, relative));
    touched.push(file);
  }
  // The declaration examples qualify the package API, which this published version does not have.
  rmSync(join(consumerDir, EXAMPLE));
  rmSync(join(consumerDir, ANALOG_EXAMPLE));
  rmSync(join(consumerDir, "tsconfig.check.analog-ssr.json"));
  const tsconfig = join(consumerDir, "tsconfig.check.json");
  const config = JSON.parse(readFileSync(tsconfig, "utf8")) as { files: string[] };
  config.files = config.files.filter((file) => file !== EXAMPLE);
  writeFileSync(tsconfig, `${JSON.stringify(config, null, 2)}\n`);
  touched.push(EXAMPLE, ANALOG_EXAMPLE, "tsconfig.check.analog-ssr.json", "tsconfig.check.json");

  return touched;
}

/** Whether this consumer copy runs on the bridged recipe. */
export const ssrBridged = (consumerDir: string): boolean =>
  existsSync(join(consumerDir, BRIDGED_RECIPE));
