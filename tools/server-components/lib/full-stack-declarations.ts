import { realpathSync } from "node:fs";
import { join } from "node:path";

import { run } from "../../consumer/lib/exec.ts";

import { ANALOG, CORE, SERVER_COMPONENTS, all } from "./full-stack-install.ts";
import { check, repoRoot } from "./harness.ts";
import { installedVersion } from "./package-consumer.ts";

/**
 * The declaration-portability check of the full-stack qualifications: the consumer's own
 * `tsc` type-checks both fixture projects (`skipLibCheck: false`) and every public Strata
 * entry's declaration must be read from `node_modules`, never from the repository or `src/`.
 */
export function tscDeclarations(
  dir: string,
  label: string,
  env: NodeJS.ProcessEnv,
): { ok: boolean; version: string } {
  const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
  const version = installedVersion(dir, "typescript");
  const configs = [
    "tsconfig.check.json",
    "tsconfig.check.server.json",
    "tsconfig.check.authorization-server.json",
    "tsconfig.check.authorization-component.json",
  ];
  const results = configs.map((config) =>
    run(process.execPath, [tsc, "-p", config, "--listFiles", "--noEmit"], { cwd: dir, env }),
  );
  const lines = results.flatMap((r) =>
    r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const listed = lines.filter((l) => l.startsWith("/"));
  const diagnostics = lines.filter((l) => /error TS\d+/.test(l));
  const strata = listed.filter((file) => file.includes("/@strata-sc/"));
  const fromRepo = listed.filter((file) =>
    realpathSync(file).startsWith(realpathSync(repoRoot) + "/"),
  );
  const entries: [string, string][] = [
    [CORE.name, "dist/index.d.ts"],
    [ANALOG.name, "dist/index.d.ts"],
    [SERVER_COMPONENTS.name, "dist/fesm2022/index.d.ts"],
    [SERVER_COMPONENTS.name, "dist/vite/index.d.ts"],
    [SERVER_COMPONENTS.name, "dist/server-only/index.d.ts"],
    [SERVER_COMPONENTS.name, "dist/fesm2022/navigation/index.d.ts"],
  ];

  console.log(
    `${label}: typescript@${version}, ${listed.length} files, ${strata.length} from the installed Strata packages, ${diagnostics.length} diagnostic(s)`,
  );

  return {
    version,
    ok: all([
      check(
        `${label}: declaration examples plus actual authorization helper/controller/SSR source (separate Angular and standard decorator projects) — strict, skipLibCheck:false, Bundler — 0 diagnostics`,
        results.every((r) => r.status === 0) && diagnostics.length === 0,
        diagnostics.slice(0, 8).join("\n") || results.map((r) => r.stderr).join("\n"),
      ),
      check(
        `${label}: every public entry's declaration (core, analog, server-components, /vite, /navigation, /server-only) is read from node_modules`,
        entries.every(([name, file]) =>
          strata.some((s) => s.endsWith(`/node_modules/${name}/${file}`)),
        ) && strata.every((file) => file.includes("/node_modules/@strata-sc/")),
        entries
          .filter(
            ([name, file]) => !strata.some((s) => s.endsWith(`/node_modules/${name}/${file}`)),
          )
          .map(([name, file]) => `${name}/${file}`)
          .join(", "),
      ),
      check(
        `${label}: no file resolves from the repository or from package src/`,
        fromRepo.length === 0 && !listed.some((file) => /@strata-sc\/[^/]+\/src\//.test(file)),
        fromRepo.join(", "),
      ),
    ]),
  };
}
