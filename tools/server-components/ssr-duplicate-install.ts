import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run } from "../consumer/lib/exec.ts";

import {
  Abort,
  fixtureTemplate,
  installFullStackConsumer,
  must,
  sha512Integrity,
} from "./lib/full-stack-install.ts";
import { check, failureCount, finish, section } from "./lib/harness.ts";
import { isolatedEnv, startNodeServer, startWrangler } from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";

/**
 * `pnpm test:server-component-ssr-duplicate-install`: what happens to the opt-in `/ssr` contract when
 * its two halves come from two independently loaded copies of @strata-sc/server-components?
 * (docs/research/rc0-production-qualification.md, "SSR installation integrity")
 *
 * The application imports the render wrapper from `node_modules/@strata-sc/server-components` and the
 * ErrorHandler provider from `strata-ssr-shell`, a real package with its OWN nested copy, which is how
 * a shared library or a pnpm peer variant produces two module instances. Both copies are unpacked real
 * tarballs: the source-packed candidate and/or the release on npm that predates the fix. The server is
 * the production entry on Nitro `node-server`; one arm repeats on Cloudflare Pages under local workerd.
 *
 * Two different duplications, because they fail for different reasons:
 *
 *   bundled   `ssr.noExternal` inlines the shell: ONE @angular/core, two copies of Strata. The two
 *             halves really run, each with its own module state.
 *   external  the shell stays external and brings a SECOND @angular/core. Its ErrorHandler and
 *             initializer tokens are not the application's, so the provider is inert.
 *
 * The published arms are permanent NEGATIVE CONTROLS: they must keep answering HTTP 200 for a failed
 * render, or this harness has stopped building a real duplicate and every other arm proves nothing.
 */

const PACKAGE = "@strata-sc/server-components";
/** The last release without the cross-copy protocol. */
const OLD_VERSION = process.env["STRATA_SSR_OLD_VERSION"] ?? "0.15.0";
const PROTOCOL_KEY = "@strata-sc/server-components:ssr-failure-contract";

type Copy = "source" | "published";
interface Arm {
  readonly id: string;
  readonly wrapper: Copy;
  /** The copy the provider comes from; `undefined` keeps the application's single copy. */
  readonly provider?: Copy;
  /** Keeps the shell out of `ssr.noExternal`, so it loads a second @angular/core. */
  readonly external?: boolean;
  readonly runtime?: "node" | "workerd";
  /** Application composition errors, without any duplicate. */
  readonly omit?: "provider" | "wrapper";
  readonly expected: {
    readonly healthy: number;
    readonly failure: number;
    /** `refused`: every request is refused, because the integration itself is broken. */
    readonly mode: "contract" | "silent-200" | "refused";
  };
  /** Copies of the protocol key in the server output, when both halves carry it. */
  readonly protocolCopies?: number;
}

const ARMS: readonly Arm[] = [
  {
    id: "control-single-copy",
    wrapper: "source",
    expected: { healthy: 200, failure: 500, mode: "contract" },
    protocolCopies: 1,
  },
  {
    id: "published-duplicate-negative-control",
    wrapper: "published",
    provider: "published",
    expected: { healthy: 200, failure: 200, mode: "silent-200" },
  },
  {
    id: "published-duplicate-external-negative-control",
    wrapper: "published",
    provider: "published",
    external: true,
    expected: { healthy: 200, failure: 200, mode: "silent-200" },
  },
  {
    id: "source-duplicate-external-angular",
    wrapper: "source",
    provider: "source",
    external: true,
    expected: { healthy: 500, failure: 500, mode: "refused" },
  },
  {
    id: "source-duplicate-same-protocol",
    wrapper: "source",
    provider: "source",
    expected: { healthy: 200, failure: 500, mode: "contract" },
    protocolCopies: 2,
  },
  {
    id: "source-duplicate-same-protocol-workerd",
    wrapper: "source",
    provider: "source",
    runtime: "workerd",
    expected: { healthy: 200, failure: 500, mode: "contract" },
    protocolCopies: 2,
  },
  {
    id: "new-wrapper-old-provider",
    wrapper: "source",
    provider: "published",
    expected: { healthy: 500, failure: 500, mode: "refused" },
  },
  {
    id: "old-wrapper-new-provider",
    wrapper: "published",
    provider: "source",
    expected: { healthy: 500, failure: 500, mode: "refused" },
  },
  {
    id: "wrapper-without-provider",
    wrapper: "source",
    omit: "provider",
    expected: { healthy: 500, failure: 500, mode: "refused" },
  },
  {
    id: "provider-without-wrapper",
    wrapper: "source",
    omit: "wrapper",
    expected: { healthy: 500, failure: 500, mode: "refused" },
  },
];

const selected = process.env["STRATA_SSR_DUP_ARMS"]?.split(",").filter(Boolean);
const arms = selected ? ARMS.filter(({ id }) => selected.includes(id)) : ARMS;

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-ssr-duplicate-"));
const consumerDir = join(tmpRoot, "consumer");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);
const time = <T>(_label: string, work: () => T): T => work();

function unpack(tarball: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  must(
    run("tar", ["-xzf", tarball, "--strip-components=1", "-C", destination], { cwd: tmpRoot }),
    `unpack ${tarball}`,
  );
}

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return /\.m?js$/.test(name) ? [path] : [];
  });
}

const occurrences = (dirs: readonly string[], needle: string): number =>
  dirs
    .filter(existsSync)
    .flatMap(textFiles)
    .reduce((count, file) => count + readFileSync(file, "utf8").split(needle).length - 1, 0);

interface Probe {
  readonly status: number;
  readonly body: string;
  readonly cacheControl: string | null;
}

async function probe(base: string, path: string): Promise<Probe> {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });

  return {
    status: response.status,
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
  };
}

try {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");

  const tool = installFullStackConsumer({ tmpRoot, consumerDir, env, time });
  const sourceTarball = tool.tarballs.get(PACKAGE)!.path;

  section(`The published copy: ${PACKAGE}@${OLD_VERSION}, verified against npm`);

  const packDir = join(tmpRoot, "published");
  mkdirSync(packDir);
  const packed = must(
    run("npm", ["pack", `${PACKAGE}@${OLD_VERSION}`, "--pack-destination", packDir, "--json"], {
      cwd: tmpRoot,
    }),
    "npm pack (published copy)",
  );
  const publishedInfo = (
    JSON.parse(packed.stdout) as { filename: string; integrity: string }[]
  )[0]!;
  const publishedTarball = join(
    packDir,
    publishedInfo.filename.replace(/^@/, "").replace("/", "-"),
  );

  check(
    `the published tarball matches npm's integrity (${publishedInfo.integrity.slice(0, 18)}…)`,
    sha512Integrity(publishedTarball) === publishedInfo.integrity,
  );

  const tarballOf = (copy: Copy): string => (copy === "source" ? sourceTarball : publishedTarball);
  const topLevel = join(consumerDir, "node_modules", PACKAGE);
  const shell = join(consumerDir, "node_modules", "strata-ssr-shell");
  const serverConfig = join(consumerDir, "src", "app", "app.config.server.ts");
  const serverMain = join(consumerDir, "src", "main.server.ts");
  const viteConfig = join(consumerDir, "vite.config.ts");
  const pristineVite = readFileSync(join(fixtureTemplate, "vite.config.ts"), "utf8");
  const pristineConfig = readFileSync(
    join(fixtureTemplate, "src/app/app.config.server.ts"),
    "utf8",
  );
  const pristineMain = readFileSync(join(fixtureTemplate, "src/main.server.ts"), "utf8");
  const ssrImport = `import { provideStrataSsrFailureHandler } from "${PACKAGE}/ssr";`;

  check("the fixture imports the provider from the package", pristineConfig.includes(ssrImport));

  for (const arm of arms) {
    section(`Arm ${arm.id}`);

    const runtime = arm.runtime ?? "node";
    let config = pristineConfig;
    let main = pristineMain;

    unpack(tarballOf(arm.wrapper), topLevel);
    rmSync(shell, { recursive: true, force: true });

    if (arm.provider) {
      unpack(tarballOf(arm.provider), join(shell, "node_modules", PACKAGE));
      writeFileSync(
        join(shell, "package.json"),
        JSON.stringify({
          name: "strata-ssr-shell",
          version: "1.0.0",
          type: "module",
          sideEffects: false,
          exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        }),
      );
      writeFileSync(
        join(shell, "index.js"),
        `export { provideStrataSsrFailureHandler } from "${PACKAGE}/ssr";\n`,
      );
      writeFileSync(
        join(shell, "index.d.ts"),
        `export { provideStrataSsrFailureHandler } from "${PACKAGE}/ssr";\n`,
      );
      config = config.replace(
        ssrImport,
        'import { provideStrataSsrFailureHandler } from "strata-ssr-shell";',
      );
    }
    if (arm.omit === "provider") {
      config = config
        .replace(ssrImport, "")
        .replace("provideStrataSsrFailureHandler(RESPONSE),", "")
        .replace(
          'import { REQUEST, RESPONSE } from "@analogjs/router/tokens";',
          'import { REQUEST } from "@analogjs/router/tokens";',
        );
    }
    if (arm.omit === "wrapper") {
      main = main
        .replace(`import { withStrataSsrFailureContract } from "${PACKAGE}/ssr";`, "")
        .replace("export default withStrataSsrFailureContract(", "export default (")
        .replace("  ]),\n);", "  ])\n);");
    }
    const bundled = arm.provider !== undefined && !arm.external;
    const vite = bundled
      ? pristineVite.replace(
          '  ssr: {\n    noExternal: ["tslib"],',
          '  ssr: {\n    noExternal: ["tslib", "strata-ssr-shell"],',
        )
      : pristineVite;

    check("the shell's bundling is what this arm declares", bundled === (vite !== pristineVite));
    writeFileSync(viteConfig, vite);
    writeFileSync(serverConfig, config);
    writeFileSync(serverMain, main);

    for (const dir of ["dist", "src/generated", ".nitro", ".angular"]) {
      rmSync(join(consumerDir, dir), { recursive: true, force: true });
    }
    must(
      run(
        process.execPath,
        [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"],
        {
          cwd: consumerDir,
          env: { ...env, ...(runtime === "workerd" ? { BUILD_PRESET: "cloudflare-pages" } : {}) },
        },
      ),
      `vite build (${arm.id})`,
    );

    const outputs = ["dist/analog/server", "dist/analog/public/_worker.js"].map((dir) =>
      join(consumerDir, dir),
    );
    if (arm.provider) {
      const shipped = existsSync(
        join(consumerDir, "dist", "analog", "server", "node_modules", "strata-ssr-shell"),
      );

      check(
        arm.external
          ? "POSITIVE CONTROL: the shell stays external, beside its own @angular/core"
          : "POSITIVE CONTROL: the shell is inlined, so one @angular/core serves both copies",
        runtime === "workerd" || shipped === (arm.external === true),
        `shell in server node_modules: ${shipped}`,
      );
    }
    if (arm.protocolCopies !== undefined) {
      const copies = occurrences(outputs, PROTOCOL_KEY);
      check(
        `the server output holds ${arm.protocolCopies} module instance(s) of the contract`,
        copies === arm.protocolCopies,
        `found ${copies}`,
      );
    }

    let server: RunningServer | undefined;
    try {
      server =
        runtime === "workerd"
          ? await startWrangler(consumerDir, env, "/about")
          : await startNodeServer(consumerDir, env);
      const base = server.baseUrl;
      const mark = server.mark();

      const healthy = await probe(base, "/products/42");
      const failures = await Promise.all(
        ["template", "constructor", "service"].map((mode) =>
          probe(base, `/render-failure/${mode}`),
        ),
      );
      const after = await probe(base, "/products/42");
      await new Promise((resolve) => setTimeout(resolve, 600));
      const log = server.since(mark);

      console.log(
        `observed: healthy=${healthy.status} failures=${failures.map(({ status }) => status).join(",")} after=${after.status}`,
      );

      check(
        `healthy page answers ${arm.expected.healthy}`,
        healthy.status === arm.expected.healthy,
        `got ${healthy.status}; log: ${log.slice(-1500)}`,
      );
      check(
        `failed renders answer ${arm.expected.failure}`,
        failures.every(({ status }) => status === arm.expected.failure),
        failures.map(({ status }) => status).join(","),
      );
      check(
        "the next healthy request is unaffected by the failures",
        after.status === arm.expected.healthy,
        `got ${after.status}`,
      );

      if (arm.expected.mode === "contract") {
        check(
          "a failed render is the generic no-store document",
          failures.every(
            ({ body, cacheControl }) =>
              body.includes('id="render-failure"') &&
              !body.includes("partial-before") &&
              cacheControl === "no-store",
          ),
        );
        check("healthy HTML is complete", healthy.body.includes("<app-root"));
      }
      if (arm.expected.mode === "silent-200") {
        check(
          "NEGATIVE CONTROL: the duplicated release really fails open, without its failure document",
          failures.every(({ body }) => !body.includes('id="render-failure"')),
        );
      }
      if (arm.expected.mode === "refused") {
        check(
          "a refused request exposes no application document or hydration state",
          [healthy, ...failures].every(
            ({ body }) => !body.includes("ng-state") && !body.includes("data-strata-"),
          ),
        );
        const strataLines = log.split("\n").filter((line) => line.includes("[strata:ssr]"));

        check(
          "the server log names the broken integration",
          strataLines.length > 0,
          log.slice(-400),
        );
        check(
          "Strata's own log lines carry no request data",
          strataLines.every((line) => !/PRIVATE|render-failure|products\/42/.test(line)),
          strataLines.join(" | "),
        );
      }
    } finally {
      await server?.stop();
    }
  }
} catch (error) {
  if (!(error instanceof Abort)) throw error;
  check("the qualification ran to completion", false, error.message);
} finally {
  if (!process.env["STRATA_KEEP_CONSUMER"] && failureCount() === 0) {
    rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.log(`consumer kept at ${dirname(consumerDir)}`);
  }
}

finish("SSR duplicate installation");
