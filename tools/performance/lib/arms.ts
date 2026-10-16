import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The four comparison arms are two independent switches over ONE application:
 *
 *   page  — an ordinary Angular component, or a Strata `@ServerComponent()` + hydrated island
 *   api   — a native Nitro route, or a Strata `@Controller()` registered on Nitro's router
 *
 * `common/` is shared by all arms; `variants/page-*` and `variants/api-*` hold the
 * only files that differ. Tarballs are installed only for the arms that use them.
 */

export type ArmId = "A" | "B" | "C" | "D";
export type PageVariant = "plain" | "server-component";
export type ApiVariant = "native" | "controller";

export interface ArmSpec {
  readonly id: ArmId;
  readonly label: string;
  readonly page: PageVariant;
  readonly api: ApiVariant;
}

export const ARMS: readonly ArmSpec[] = [
  { id: "A", label: "native baseline", page: "plain", api: "native" },
  { id: "B", label: "controllers only", page: "plain", api: "controller" },
  { id: "C", label: "server components only", page: "server-component", api: "native" },
  { id: "D", label: "full Strata", page: "server-component", api: "controller" },
];

export const CORE = "@strata-sc/core";
export const ANALOG = "@strata-sc/analog";
export const SERVER_COMPONENTS = "@strata-sc/server-components";

/** The Strata packages an arm installs (and therefore may import). */
export function strataPackagesOf(arm: ArmSpec): readonly string[] {
  return [
    ...(arm.api === "controller" ? [CORE, ANALOG] : []),
    ...(arm.page === "server-component" ? [SERVER_COMPONENTS] : []),
  ];
}

export const usesStrata = (arm: ArmSpec): boolean => strataPackagesOf(arm).length > 0;

export const SERVER_ONLY_IMPORT = 'import "@strata-sc/server-components/server-only";';
export const VARIANT_TOKEN = "//@variant:server-only-import";

/** Every file path under `dir`, relative, sorted, skipping nothing. */
function listAll(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const full = join(dir, name);

      return statSync(full).isDirectory() ? listAll(full, base) : [full.slice(base.length + 1)];
    })
    .sort();
}

export interface AssembleOptions {
  readonly template: string;
  readonly destination: string;
  readonly arm: ArmSpec;
  /** Absolute tarball path per Strata package name; only this arm's packages are read. */
  readonly tarballs: Readonly<Record<string, string>>;
  /**
   * How the native Nitro route answers: `response` builds a web `Response` like the controller
   * (the like-for-like default), `object` returns a plain object through h3's own serializer.
   */
  readonly nativeStyle?: "response" | "object";
}

export interface Assembled {
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
}

/**
 * Copies `common/` plus the arm's two variant overlays into `destination`, resolves the
 * one `server-only` token and writes the arm's Strata tarball dependencies. A variant
 * file may not silently replace a common file: overlap is an error.
 */
export function assembleArm({
  template,
  destination,
  arm,
  tarballs,
  nativeStyle = "response",
}: AssembleOptions): Assembled {
  const common = join(template, "common");
  const overlays = [
    join(template, "variants", `page-${arm.page}`),
    join(
      template,
      "variants",
      arm.api === "native" && nativeStyle === "object" ? "api-native-object" : `api-${arm.api}`,
    ),
  ];
  const placed = new Set<string>();

  for (const root of [common, ...overlays]) {
    if (!existsSync(root)) throw new Error(`Missing fixture directory: ${root}`);

    for (const file of listAll(root)) {
      if (placed.has(file)) throw new Error(`Variant file overrides another file: ${file}`);
      placed.add(file);
    }

    cpSync(root, destination, { recursive: true });
  }

  const serverOnly = arm.page === "server-component";

  for (const file of placed) {
    if (!file.endsWith(".ts")) continue;

    const path = join(destination, file);
    const source = readFileSync(path, "utf8");

    if (!source.includes(VARIANT_TOKEN)) continue;
    writeFileSync(
      path,
      source.replace(VARIANT_TOKEN, serverOnly ? SERVER_ONLY_IMPORT : "").replace(/^\n/, ""),
    );
  }

  const manifestPath = join(destination, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
  };

  for (const name of strataPackagesOf(arm)) {
    const tarball = tarballs[name];

    if (tarball === undefined) throw new Error(`No tarball for ${name}`);
    manifest.dependencies[name] = `file:${tarball}`;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { files: [...placed].sort(), dependencies: manifest.dependencies };
}
