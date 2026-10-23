import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listFiles } from "../analog/lib/scan.ts";
import { observeStreaming } from "../analog/lib/streaming.ts";
import { run } from "../consumer/lib/exec.ts";
import type { CommandResult } from "../consumer/lib/exec.ts";
import { readManifest } from "../release/lib/packages.ts";

import {
  FULL_STACK_MARKERS,
  FULL_STACK_SERVER_SOURCES,
  PRIVATE_CANARIES,
  SERVER_ONLY_MARKERS,
} from "./lib/full-stack-fixture.ts";
import {
  ANALOG,
  Abort,
  CORE,
  FULL_STACK_PACKAGES as PACKAGES,
  NOT_SOURCE,
  SERVER_COMPONENTS,
  all,
  fixtureTemplate,
  installFullStackConsumer,
  must,
  sanitize,
} from "./lib/full-stack-install.ts";
import { routingBrowserSuite, routingSuite } from "./lib/full-stack-routing.ts";
import { httpSuite, islandSuite, navigationSuite } from "./lib/full-stack-verify.ts";
import { check, finish, repoRoot, section } from "./lib/harness.ts";
import { moduleGraph } from "./lib/module-graph.ts";
import {
  installedVersion,
  isolatedEnv,
  restoreDir,
  snapshotDiffers,
  snapshotDir,
  startNodeServer,
  startWrangler,
} from "./lib/package-consumer.ts";
import type { RunningServer, Snapshot } from "./lib/package-consumer.ts";
import { COMPATIBILITY_DATE } from "./lib/wrangler.ts";

/**
 * `pnpm test:full-stack-package-consumer`: do the PACKED @strata-sc/core,
 * @strata-sc/analog and @strata-sc/server-components work together in ONE
 * independent Analog application outside the Strata workspace?
 * (docs/research/full-stack-external-consumer.md)
 *
 *   package builds → `pnpm pack` → three .tgz (the only connection)
 *   → OS temp directory → `npm install` → real Analog app with
 *       Strata controller → HTTP API → interactive Angular island
 *       server-only repository → @ServerComponent() → SSR HTML → hydrated island
 *   → tarball/install/dependency-graph integrity, declarations (TS 6 and 5.9),
 *     Node production build + SSR + hydration + navigation, server-only
 *     firewall, Cloudflare Pages build + local workerd.
 *
 * It never edits a package manifest, never publishes, and never resolves
 * anything from the repository: the consumer's own `node_modules` run every
 * command.
 */

const TITLE = "full-stack packed-package consumer qualification";

const TS59_VERSION = "5.9.2";

const verdict = {
  install: false,
  controllerIntegration: false,
  serverComponents: false,
  island: false,
  routing: false,
  declarations59: false,
  declarations6: false,
  node: false,
  firewall: false,
  cloudflare: false,
  confidentiality: false,
};

const timings: string[] = [];
const timeAsync = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const started = performance.now();

  try {
    return await work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};
const time = <T>(label: string, work: () => T): T => {
  const started = performance.now();

  try {
    return work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};

const servers: RunningServer[] = [];
const tmpRoot = mkdtempSync(join(tmpdir(), "strata-full-stack-consumer-"));
const consumerDir = join(tmpRoot, "consumer");
const ts59Dir = join(tmpRoot, "consumer-ts59");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);

let templateBefore: Snapshot | undefined;
let pristine: Snapshot | undefined;

/** The consumer's own `vite` binary (never the repository's). */
const vite = (args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): CommandResult =>
  run(process.execPath, [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), ...args], {
    cwd: consumerDir,
    env: { ...env, ...extraEnv },
  });

function clean(): void {
  for (const dir of ["dist", "src/generated", ".nitro", ".angular"]) {
    rmSync(join(consumerDir, dir), { recursive: true, force: true });
  }
}

function build(label: string, extraEnv: NodeJS.ProcessEnv = {}): CommandResult {
  clean();

  return time(label, () => must(vite(["build"], extraEnv), label));
}

const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);
const graphFiles = (dirs: readonly string[], skip: (file: string) => boolean = () => false) =>
  dirs
    .flatMap((dir) =>
      existsSync(dist(dir)) ? listFiles(dist(dir)).map((file) => `${dir}/${file}`) : [],
    )
    .filter((file) => !skip(file));
const filesWith = (files: readonly string[], needle: string): string[] =>
  files.filter((file) => readFileSync(dist(file), "utf8").includes(needle));

/** Source paths named by the `.map` files among `files`. */
function mapSources(files: readonly string[]): string[] {
  return files
    .filter((file) => file.endsWith(".map"))
    .flatMap(
      (file) =>
        (JSON.parse(readFileSync(dist(file), "utf8")) as { sources?: string[] }).sources ?? [],
    );
}

try {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");
  templateBefore = snapshotDir(fixtureTemplate, () => false);

  // ------------------------------------------------------------------------

  const tool = installFullStackConsumer({ tmpRoot, consumerDir, env, time });
  const { tarballs, installArgs, consumerManifest, manifests } = tool;

  pristine = tool.pristine;
  verdict.install = tool.ok;

  // ------------------------------------------------------------------------
  section("Declaration portability (TypeScript 6 and 5.9, skipLibCheck: false)");

  const tscDeclarations = (dir: string, label: string): { ok: boolean; version: string } => {
    const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
    const version = installedVersion(dir, "typescript");
    const configs = ["tsconfig.check.json", "tsconfig.check.server.json"];
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
          `${label}: both consumer projects (Angular decorators, standard-decorator controllers) — strict, skipLibCheck:false, Bundler — 0 diagnostics`,
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
  };

  const ts6 = tscDeclarations(consumerDir, "TypeScript 6");

  check("TypeScript 6.0.3 is the declaration consumer", ts6.version === "6.0.3", ts6.version);
  verdict.declarations6 = ts6.ok && ts6.version === "6.0.3";

  mkdirSync(join(ts59Dir, "src", "check"), { recursive: true });
  for (const file of [
    "tsconfig.check.json",
    "tsconfig.check.server.json",
    "src/check/declarations.ts",
    "src/check/controller-declarations.ts",
    "src/check/http-contract-example.ts",
    "src/check/api-boundary-example.ts",
    "src/check/stream-example.ts",
  ]) {
    cpSync(join(consumerDir, file), join(ts59Dir, file));
  }
  writeFileSync(
    join(ts59Dir, "package.json"),
    `${JSON.stringify(
      {
        name: "strata-full-stack-declarations-ts59",
        private: true,
        type: "module",
        dependencies: {
          ...Object.fromEntries(
            PACKAGES.map((p) => [p.name, `file:${tarballs.get(p.name)!.path}`]),
          ),
          ...Object.fromEntries(
            [
              "@angular/core",
              "@angular/common",
              "@angular/compiler",
              "@angular/router",
              "rxjs",
            ].map((name) => [name, consumerManifest.dependencies[name]]),
          ),
          vite: consumerManifest.devDependencies["vite"],
          zod: consumerManifest.dependencies["zod"],
          "@types/node": consumerManifest.devDependencies["@types/node"],
          typescript: TS59_VERSION,
        },
      },
      null,
      2,
    )}\n`,
  );
  time("npm install (TypeScript 5.9 consumer)", () =>
    must(run("npm", installArgs, { cwd: ts59Dir, env }), "npm install (TypeScript 5.9 consumer)"),
  );

  const ts59 = tscDeclarations(ts59Dir, "TypeScript 5.9");

  check(
    `TypeScript ${TS59_VERSION} is the declaration consumer`,
    ts59.version === TS59_VERSION,
    ts59.version,
  );
  verdict.declarations59 = ts59.ok && ts59.version === TS59_VERSION;

  // ------------------------------------------------------------------------
  section("External production build (Node): graph separation");

  build("consumer `vite build`");

  const surrogate = join(
    consumerDir,
    "src",
    "generated",
    "server-components",
    "products",
    "product-details.server-component.ts",
  );

  check(
    "the Server Component surrogate is generated inside the EXTERNAL app",
    existsSync(surrogate),
  );
  check(
    "the surrogate imports the runtime as `@strata-sc/server-components`, never a path",
    /from "@strata-sc\/server-components";/.test(readFileSync(surrogate, "utf8")) &&
      !readFileSync(surrogate, "utf8").includes(repoRoot),
  );

  const browserDirs = ["client", "analog/public"] as const;
  const browser = graphFiles(browserDirs);
  const server = graphFiles(["analog/server", "ssr"]);
  const browserJs = browser.filter((f) => f.endsWith(".js"));
  const serverJs = server.filter((f) => /\.(m?js)$/.test(f));
  const graphOk: boolean[] = [];

  for (const marker of PRIVATE_CANARIES) {
    graphOk.push(
      check(
        `${marker}: absent from every browser file, source map included`,
        filesWith(browser, marker).length === 0,
        filesWith(browser, marker).join(", "),
      ),
    );
  }
  for (const marker of SERVER_ONLY_MARKERS) {
    graphOk.push(
      check(
        `${marker}: present in the Node server graph (positive control)`,
        filesWith(serverJs, marker).length > 0,
      ),
    );
  }

  const browserSources = mapSources(browser);
  const serverSourcesInBrowser = browserSources.filter(
    (source) =>
      FULL_STACK_SERVER_SOURCES.some(
        (file) => source.endsWith(file) && !source.includes("/generated/"),
      ) || /@strata-sc\/(core|analog)\/|\/src\/server\//.test(source),
  );

  console.log(`browser source maps: ${browserSources.length} sources`);
  graphOk.push(
    check("browser source maps exist (the graph check is not vacuous)", browserSources.length > 20),
    check(
      "browser source maps name none of the consumer's server files and neither @strata-sc/core nor @strata-sc/analog",
      serverSourcesInBrowser.length === 0,
      serverSourcesInBrowser.join(", "),
    ),
    check(
      "browser source maps include the island and the generated surrogate, and the packed server-components runtime",
      browserSources.some((s) => s.endsWith("product-availability.component.ts")) &&
        browserSources.some((s) =>
          s.includes("generated/server-components/products/product-details.server-component.ts"),
        ) &&
        browserSources.some((s) =>
          s.includes("node_modules/@strata-sc/server-components/dist/fesm2022/"),
        ) &&
        !browserSources.some((s) => /packages\/server-components|\/Strata\//.test(s)),
    ),
    check(
      "no controller, adapter or registration code in any browser script",
      ["registerControllers", "getControllerDefinition", "ProductsController", "nitropack"].every(
        (needle) => filesWith(browserJs, needle).length === 0,
      ),
    ),
    check(
      `${FULL_STACK_MARKERS.client}: present in the browser graph (positive control)`,
      filesWith(browserJs, FULL_STACK_MARKERS.client).length > 0,
    ),
  );

  const serverMaps = mapSources(server);

  graphOk.push(
    check(
      "server output includes the consumer's server-only Angular sources (source-map positive control)",
      ["product.repository.ts", "server-helper.ts", "product-details.server-component.ts"].every(
        (file) => serverMaps.some((s) => s.endsWith(file)),
      ),
    ),
  );

  const controllerChunks = filesWith(serverJs, "ProductsController");
  const controllerSource = controllerChunks.map((f) => readFileSync(dist(f), "utf8")).join("\n");

  graphOk.push(
    check(
      "the controller is in the Nitro server bundle, lowered from STANDARD decorators (no legacy __decorate, no reflect-metadata)",
      controllerChunks.length > 0 &&
        /__decorateElement|__esDecorate/.test(controllerSource) &&
        !/__decorate\(|__metadata\(|Reflect\.metadata|reflect-metadata/.test(controllerSource),
      controllerChunks.join(", "),
    ),
  );

  // ------------------------------------------------------------------------
  section("Production Node server: controller API, SSR, hydration, interaction, navigation");

  const node = await timeAsync("start production server", () => startNodeServer(consumerDir, env));

  servers.push(node);

  const nodeHttp = await httpSuite(node.baseUrl, "node", {
    lifecycle: true,
    log: () => node.output(),
  });
  const nodeIsland = await islandSuite(node.baseUrl, "node");
  const nodeNavigation = await navigationSuite(node.baseUrl, "node");
  const nodeRouting = [
    ...(await routingSuite(node.baseUrl, "node", { lifecycle: true, log: () => node.output() })),
    ...(await routingBrowserSuite(node.baseUrl, "node")),
  ];

  const nodeStreaming: boolean[] = [];

  await observeStreaming(node.baseUrl, "node", (name, passed, detail) => {
    nodeStreaming.push(check(name, passed, detail));

    return passed;
  });

  await node.stop();
  servers.length = 0;

  const nodeAll = [
    ...nodeStreaming,
    ...nodeHttp.controller,
    ...nodeHttp.serverComponents,
    ...nodeIsland.ok,
    ...nodeNavigation,
    ...nodeRouting,
    ...graphOk,
  ];

  verdict.node = all(nodeAll);
  verdict.controllerIntegration = all(nodeHttp.controller);
  verdict.serverComponents = all(nodeHttp.serverComponents);
  verdict.island = all([...nodeIsland.ok, ...nodeNavigation]);
  verdict.routing = all(nodeRouting);
  verdict.confidentiality = all(graphOk) && all(nodeIsland.ok);

  // ------------------------------------------------------------------------
  section("server-only firewall from the installed plugin (production build)");

  const firewall: boolean[] = [];
  const island = join(consumerDir, "src", "app", "products", "product-availability.component.ts");

  restoreDir(consumerDir, pristine, NOT_SOURCE);
  writeFileSync(
    island,
    `import { ProductRepository } from "./product.repository";\n${readFileSync(
      island,
      "utf8",
    ).replace(
      "protected readonly marker = CLIENT_MARKER;",
      "protected readonly marker = CLIENT_MARKER;\n  protected readonly leak = ProductRepository.name;",
    )}`,
  );
  clean();

  const illegal = vite(["build"]);
  const output = sanitize(`${illegal.stdout}\n${illegal.stderr}`);

  firewall.push(
    check(
      "an island importing the server-only repository fails the production build",
      illegal.status !== 0,
      output.slice(-600),
    ),
    check(
      "the diagnostic comes from the installed plugin and names the consumer importer and the fix",
      /\[strata\] Server-only module entered the browser graph: src\/app\/products\/product\.repository\.ts/.test(
        output,
      ) &&
        /Imported from: src\/app\/products\/product-availability\.component\.ts/.test(output) &&
        /Move the dependency behind the Server Component boundary/.test(output),
      output.match(/\[strata\][^\n]*/)?.[0] ?? "",
    ),
    check(
      "the diagnostic prints no marker, no repository path and no module contents",
      PRIVATE_CANARIES.every((c) => !output.includes(c)) && !output.includes(repoRoot),
    ),
  );
  restoreDir(consumerDir, pristine, NOT_SOURCE);
  clean();

  const restoredProblems = snapshotDiffers(consumerDir, pristine, NOT_SOURCE);

  firewall.push(
    check(
      "the consumer sources are back to their original bytes after the failing scenario",
      restoredProblems.length === 0,
      restoredProblems.join(", "),
    ),
  );
  verdict.firewall = all(firewall);

  // ------------------------------------------------------------------------
  section("External Cloudflare Pages build and workerd (consumer-installed wrangler)");

  const cfOk: boolean[] = [];

  build("consumer `vite build` with BUILD_PRESET=cloudflare-pages", {
    BUILD_PRESET: "cloudflare-pages",
  });

  const nitroMeta = JSON.parse(readFileSync(dist("analog", "nitro.json"), "utf8")) as {
    preset?: string;
  };
  const workerDir = dist("analog", "public", "_worker.js");
  const worker = moduleGraph(workerDir, "index.js");
  const workerJs = worker.modules.map((module) => `analog/public/_worker.js/${module}`);
  const publicAssets = graphFiles(["analog/public", "client"], (file) =>
    file.startsWith("analog/public/_worker.js/"),
  );

  console.log(
    `Worker: ${worker.modules.length} reachable modules; compatibility date ${COMPATIBILITY_DATE}; flags: (none; nodejs_compat NOT enabled)`,
  );
  cfOk.push(
    check(
      "the build resolves the cloudflare-pages preset",
      nitroMeta.preset === "cloudflare-pages",
      String(nitroMeta.preset),
    ),
    check(
      "a Worker was built (analog/public/_worker.js/index.js)",
      existsSync(join(workerDir, "index.js")),
    ),
  );
  for (const marker of SERVER_ONLY_MARKERS) {
    cfOk.push(
      check(
        `${marker}: in the Worker graph`,
        workerJs.some((file) => readFileSync(dist(file), "utf8").includes(marker)),
      ),
    );
  }
  for (const marker of PRIVATE_CANARIES) {
    cfOk.push(
      check(
        `${marker}: absent from the public browser assets and maps`,
        filesWith(publicAssets, marker).length === 0,
        filesWith(publicAssets, marker).join(", "),
      ),
    );
  }

  const publicSources = mapSources(publicAssets);

  cfOk.push(
    check(
      "public source maps name none of the consumer's server files, @strata-sc/core or @strata-sc/analog",
      !publicSources.some(
        (source) =>
          FULL_STACK_SERVER_SOURCES.some(
            (file) => source.endsWith(file) && !source.includes("/generated/"),
          ) || /@strata-sc\/(core|analog)\/|\/src\/server\//.test(source),
      ),
    ),
    check(
      "the Worker's unresolved imports are not Node built-ins (nodejs_compat is not enabled)",
      worker.externals.every(({ specifier }) => specifier.startsWith("node:") === false),
      worker.externals.map((e) => e.specifier).join(", "),
    ),
  );

  const wrangler = await timeAsync("start wrangler pages dev", () =>
    startWrangler(consumerDir, env, "/products/42"),
  );

  servers.push(wrangler);
  console.log(`wrangler (consumer-installed): ${installedVersion(consumerDir, "wrangler")}`);

  const cfHttp = await httpSuite(wrangler.baseUrl, "workerd", {
    lifecycle: true,
    log: () => wrangler.output(),
  });
  const cfIsland = await islandSuite(wrangler.baseUrl, "workerd");
  const cfNavigation = await navigationSuite(wrangler.baseUrl, "workerd");
  const cfRouting = [
    ...(await routingSuite(wrangler.baseUrl, "workerd", {
      lifecycle: true,
      log: () => wrangler.output(),
    })),
    ...(await routingBrowserSuite(wrangler.baseUrl, "workerd")),
  ];

  const cfStreaming: boolean[] = [];

  await observeStreaming(wrangler.baseUrl, "workerd", (name, passed, detail) => {
    cfStreaming.push(check(name, passed, detail));

    return passed;
  });

  cfOk.push(
    ...cfStreaming,
    ...cfHttp.controller,
    ...cfHttp.serverComponents,
    ...cfIsland.ok,
    ...cfNavigation,
    ...cfRouting,
    check(
      "workerd: no code-generation or JIT error in the runtime log",
      !/Code generation from strings disallowed|JIT compilation|needs to be compiled using the JIT/.test(
        sanitize(wrangler.output()),
      ),
      sanitize(wrangler.output()).slice(-600),
    ),
  );
  await wrangler.stop();
  servers.length = 0;
  verdict.cloudflare = all(cfOk);

  // ------------------------------------------------------------------------
  section("The template and the packages are untouched");

  const templateNow = snapshotDiffers(fixtureTemplate, templateBefore, () => false);

  check(
    "the fixture template in the repository is unchanged",
    templateNow.length === 0,
    templateNow.join(", "),
  );
  check(
    "no package manifest changed during the qualification",
    PACKAGES.every(
      (pkg, index) =>
        readManifest(join(repoRoot, pkg.dir)).version === manifests[index]!.manifest.version,
    ),
  );
} catch (error) {
  if (!(error instanceof Abort)) {
    check(
      "the qualification ran to completion",
      false,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
} finally {
  for (const server of servers) await server.stop().catch(() => undefined);

  console.log(`\ntimings: ${timings.join("; ")}`);

  if (process.env["STRATA_KEEP_CONSUMER"] === "1") {
    console.log(`kept: ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

section("Verdict");
check("external packed-package installation", verdict.install);
check("declaration portability (TypeScript 5.9.2)", verdict.declarations59);
check("declaration portability (TypeScript 6)", verdict.declarations6);
check("Core + Analog controller integration (Node)", verdict.controllerIntegration);
check("Server Components integration (Node)", verdict.serverComponents);
check("interactive island + controller HTTP API + navigation (Node)", verdict.island);
check(
  "HTTP routing and API boundary contract (Node production + workerd)",
  verdict.routing && verdict.cloudflare,
);
check("Node production consumer", verdict.node);
check("server-only firewall from the installed plugin", verdict.firewall);
check("Cloudflare/workerd consumer", verdict.cloudflare);
check("graph confidentiality", verdict.confidentiality);

finish(TITLE);
