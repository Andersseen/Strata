import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findFreePort, httpGet } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";

import { SERVER_MARKERS, SERVER_SOURCES } from "./lib/consumer-fixture.ts";
import { check, finish, section } from "./lib/harness.ts";
import {
  WIDGETS_PACKAGE,
  prepareWorkspace,
  sanitize,
  writeConsumerFile,
} from "./lib/installed-island.ts";
import { RUNTIME_CASES, checkRuntimeMatrix } from "./lib/installed-runtime.ts";
import type { RuntimeCase } from "./lib/installed-runtime.ts";
import { startNodeServer, startServer, startWrangler } from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";
import { scanBuildOutput } from "./lib/ssr-integrity.ts";

/**
 * `pnpm test:server-component-installed-island`: M4 qualification of an INSTALLED Angular library
 * used as Strata client islands (docs/research/server-component-installed-island-qualification.md).
 *
 *   build → pack Strata → pack the Angular library twice (v1, v2) → npm install into a consumer
 *   outside the repository → positive build, AOT/linker proof and confidentiality scan →
 *   browser-time reference matrix (Node, workerd) → build-time reference matrix →
 *   package upgrade and cache characterization.
 */

const TITLE = "server-component installed-island qualification";
const PRODUCT = "src/app/product/product-details.server-component.ts";
const VITE_CONFIG = "vite.config.ts";
const PICKER_MARKER = "STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT";

const workspace = prepareWorkspace();
const { consumerDir, env } = workspace;
const servers: RunningServer[] = [];
const verdict: Record<string, boolean> = {};

const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);
const filesIn = (
  dirs: readonly string[],
  skip: (file: string) => boolean = () => false,
): string[] =>
  dirs
    .flatMap((dir) =>
      existsSync(dist(dir)) ? listFiles(dist(dir)).map((file) => `${dir}/${file}`) : [],
    )
    .filter((file) => !skip(file));
const filesWith = (files: readonly string[], needle: string): string[] =>
  files.filter((file) => readFileSync(dist(file), "utf8").includes(needle));
const all = (results: readonly boolean[]): boolean => results.every(Boolean);

/** Adds one `clientComponents` entry to the consumer's Vite config. */
const register = (selector: string, subpath: string, exportName: string) => (source: string) =>
  source.replace(
    "clientComponents: [",
    `clientComponents: [
        { selector: "${selector}", module: "${WIDGETS_PACKAGE}${subpath}", exportName: "${exportName}" },`,
  );

/** Imports `names` from the package's `/negatives` entry into the Server Component's `imports`. */
const importNegatives =
  (names: readonly string[], element?: string) =>
  (source: string): string => {
    const withImports = `import { ${names.join(", ")} } from "${WIDGETS_PACKAGE}/negatives";\n${source.replace(
      "imports: [",
      `imports: [\n    ${names.join(",\n    ")},`,
    )}`;

    return element
      ? withImports.replace(
          "<legacy-counter",
          `<${element} [strataClient]="{}" />\n    <legacy-counter`,
        )
      : withImports;
  };

const build = (label: string, extraEnv: NodeJS.ProcessEnv = {}): boolean => {
  workspace.clean();

  const started = performance.now();
  const result = workspace.vite(["build"], extraEnv);

  console.log(`  ·    ${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);

  return check(
    `${label} exits 0`,
    result.status === 0,
    sanitize(`${result.stdout}\n${result.stderr}`).slice(-1_500),
  );
};

async function startNode(): Promise<RunningServer> {
  const server = await startNodeServer(consumerDir, env);

  servers.push(server);

  return server;
}

async function stopAll(): Promise<void> {
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
}

try {
  // ------------------------------------------------------------------------
  section("Installed packages: provenance and Angular compilation");

  const installedWidgets = join(consumerDir, "node_modules", "@strata-test", "angular-widgets");
  const widgetsEntry = join(installedWidgets, "dist", "fesm2022", "index.js");

  verdict["install"] = all([
    check(
      "the consumer lives outside the repository and installed both tarballs with npm",
      !consumerDir.includes("/projects/Strata/") &&
        existsSync(join(consumerDir, "package-lock.json")) &&
        existsSync(join(consumerDir, "node_modules", "@strata-sc", "server-components", "dist")),
    ),
    check(
      "the installed library is a real directory of partial-compiled FESM (Angular's linker has work to do)",
      existsSync(widgetsEntry) &&
        readFileSync(widgetsEntry, "utf8").includes("ɵɵngDeclareComponent") &&
        !readFileSync(widgetsEntry, "utf8").includes("ɵɵdefineComponent"),
    ),
    check(
      "the library is installed from its tarball: not a symlink, no src/",
      !existsSync(join(installedWidgets, "src")) &&
        (
          JSON.parse(readFileSync(join(installedWidgets, "package.json"), "utf8")) as {
            version: string;
          }
        ).version === "0.0.0-test",
    ),
  ]);

  // ------------------------------------------------------------------------
  section("Positive consumer: production build, AOT/linker proof, confidentiality");

  const built = build("consumer `vite build` (v1 library)");
  const outputScan = scanBuildOutput(
    {
      classes: ["ssr", "analog/server", "client"].map((root) => dist(root)),
      partials: ["ssr", "client"].map((root) => dist(root)),
    },
    consumerDir,
  );
  const browser = filesIn(["client", "analog/public"]);
  const browserJs = browser.filter((file) => file.endsWith(".js"));
  const server = filesIn(["analog/server", "ssr"]);
  const serverJs = server.filter((file) => /\.m?js$/.test(file));
  const surrogate = readFileSync(
    join(
      consumerDir,
      "src/generated/server-components/product/product-details.server-component.ts",
    ),
    "utf8",
  );
  const lazyChunks = browserJs.filter((file) => !/\/index-[^/]*\.js$/.test(file));
  const manifests = browser.filter(
    (file) => file.endsWith(".json") || file.endsWith(".webmanifest"),
  );
  const sourceMaps = browser.filter((file) => file.endsWith(".map"));
  const mapSources = sourceMaps.flatMap(
    (file) =>
      (JSON.parse(readFileSync(dist(file), "utf8")) as { sources?: string[] }).sources ?? [],
  );
  const html = (await Promise.resolve(browser.filter((file) => file.endsWith(".html")))).map(
    (file) => readFileSync(dist(file), "utf8"),
  );

  verdict["positive"] = all([
    built,
    check(
      "every emitted Angular class is compiled and no partial declaration reached the bundles (linker ran on the installed library)",
      outputScan.uncompiled.length === 0 &&
        outputScan.unlinked.length === 0 &&
        outputScan.definitions > 0,
      JSON.stringify({ uncompiled: outputScan.uncompiled, unlinked: outputScan.unlinked }),
    ),
    check(
      "the linked installed component definition is in both the server and the browser graph",
      filesWith(serverJs, PICKER_MARKER).length > 0 &&
        filesWith(browserJs, PICKER_MARKER).length > 0,
    ),
    check(
      "the generated surrogate lists both installed components by bare package specifier and expected selector",
      surrogate.includes(`from "${WIDGETS_PACKAGE}";`) &&
        surrogate.includes('expectedSelector: "acme-product-picker"'),
    ),
  ]);

  // Confidentiality: scanner control first, then the real graph.
  const controlDir = join(workspace.root, "scan-control");

  rmSync(controlDir, { recursive: true, force: true });
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(join(controlDir, "leak.js"), `export const x = "${SERVER_MARKERS[0]}";\n`);
  writeFileSync(
    join(controlDir, "leak.js.map"),
    JSON.stringify({ version: 3, sources: [`../src/app/product/${SERVER_SOURCES[0]}`] }),
  );

  const scanDetects = listFiles(controlDir).filter((file) =>
    readFileSync(join(controlDir, file), "utf8").includes(SERVER_MARKERS[0]),
  );
  const sourcesDetect = (sources: readonly string[]): string[] =>
    sources.filter((source) =>
      SERVER_SOURCES.some((name) => source.endsWith(name) && !source.includes("/generated/")),
    );

  verdict["confidentiality"] = all([
    check(
      "negative control: the scanner finds a canary and a server source in a synthetic browser file",
      scanDetects.length === 1 &&
        sourcesDetect(
          (
            JSON.parse(readFileSync(join(controlDir, "leak.js.map"), "utf8")) as {
              sources: string[];
            }
          ).sources,
        ).length === 1,
    ),
    ...SERVER_MARKERS.map((marker) =>
      check(
        `${marker}: absent from every browser file, lazy chunk, preload asset and manifest`,
        filesWith(browser, marker).length === 0,
        filesWith(browser, marker).join(", "),
      ),
    ),
    ...SERVER_MARKERS.map((marker) =>
      check(
        `${marker}: present in the server graph (positive control)`,
        filesWith(serverJs, marker).length > 0,
      ),
    ),
    check(
      "browser source maps exist, name no consumer server file, and include the installed library",
      sourceMaps.length > 0 &&
        sourcesDetect(mapSources).length === 0 &&
        mapSources.some((source) => source.includes("angular-widgets/dist/fesm2022/index.js")) &&
        mapSources.some((source) => source.includes("angular-widgets/dist/fesm2022/second.js")),
      sourcesDetect(mapSources).join(", "),
    ),
    check(
      "the surrogate (generated reference module) names no server implementation",
      SERVER_MARKERS.every((marker) => !surrogate.includes(marker)) &&
        !surrogate.includes("ProductRepository") &&
        !surrogate.includes("server-helper"),
    ),
    check(
      "the browser chunk graph has lazy chunks and a document, and none names a server symbol",
      lazyChunks.length > 0 &&
        html.length > 0 &&
        ["ProductRepository", "readServerHelper", "IMPLEMENTATION_MARKER"].every(
          (name) => filesWith(browserJs, name).length === 0,
        ),
      `${lazyChunks.length} lazy chunks, ${manifests.length} manifest files`,
    ),
  ]);

  // ------------------------------------------------------------------------
  section("Browser-time reference matrix: Node production server");

  const node = await startNode();
  const errorResponse = await httpGet(`${node.baseUrl}/missing-route-${Date.now()}`);

  verdict["nodeRuntime"] = all([
    check(
      "a public error response carries no server marker, source path or stack",
      SERVER_MARKERS.every((marker) => !errorResponse.body.includes(marker)) &&
        !/product\.repository|at .*\.(m?js|ts):\d+/.test(errorResponse.body),
      String(errorResponse.status),
    ),
    await checkRuntimeMatrix("Node", node.baseUrl),
  ]);
  await node.stop();
  servers.length = 0;

  // ------------------------------------------------------------------------
  section("Browser-time reference matrix: local Cloudflare Pages / workerd");

  if (
    build("consumer `vite build` with BUILD_PRESET=cloudflare-pages", {
      BUILD_PRESET: "cloudflare-pages",
    })
  ) {
    const workerdJs = filesIn(["analog/public/_worker.js"]).filter((file) => /\.m?js$/.test(file));
    const workerd = await startWrangler(consumerDir, env, "/mixed");

    servers.push(workerd);
    verdict["workerd"] = all([
      check(
        "the Worker bundles the linked installed library and every server marker",
        filesWith(workerdJs, PICKER_MARKER).length > 0 &&
          SERVER_MARKERS.every((marker) => filesWith(workerdJs, marker).length > 0),
      ),
      check(
        "no server marker reaches the public Pages assets",
        SERVER_MARKERS.every(
          (marker) =>
            filesWith(
              filesIn(["analog/public"], (file) => file.startsWith("analog/public/_worker.js/")),
              marker,
            ).length === 0,
        ),
      ),
      await checkRuntimeMatrix("workerd", workerd.baseUrl),
    ]);
    await workerd.stop();
    servers.length = 0;
  } else {
    verdict["workerd"] = false;
  }

  // ------------------------------------------------------------------------
  section(
    "Build-time reference matrix (the compiler must fail closed where the reference is visible)",
  );

  interface BuildCase {
    readonly label: string;
    readonly files: Record<string, string | ((source: string) => string)>;
    /** Expected: the build fails and the output matches. */
    readonly fails?: RegExp;
    /** Expected: the build succeeds (documented runtime-only enforcement). */
    readonly builds?: true;
  }

  const dropPicker = (source: string): string =>
    source
      .replace('import { ProductPickerComponent } from "@strata-test/angular-widgets";\n', "")
      .replace("    ProductPickerComponent,\n", "");
  const dropPickerRegistration = (source: string): string =>
    source.replace(/\{\s*selector: "acme-product-picker",[^}]*\},/, "");

  const buildCases: BuildCase[] = [
    {
      label: "B: registered export declares a different selector",
      files: {
        [VITE_CONFIG]: (s) =>
          register(
            "acme-product-picker",
            "/negatives",
            "MismatchedPickerComponent",
          )(dropPickerRegistration(s)),
        [PRODUCT]: (s) => importNegatives(["MismatchedPickerComponent"])(dropPicker(s)),
      },
      fails: /Can't bind to 'productView' since it isn't a known property of 'acme-product-picker'/,
    },
    {
      label: "C: two distinct components claim one selector in one template",
      files: { [PRODUCT]: importNegatives(["DuplicatePickerComponent"]) },
      fails: /Multiple components match node with tagname acme-product-picker/,
    },
    {
      label: "C: two registry entries claim one selector",
      files: {
        [VITE_CONFIG]: register("acme-product-picker", "/negatives", "DuplicatePickerComponent"),
      },
      fails: /\[strata\] duplicate client component selector "acme-product-picker" in registry/,
    },
    {
      label: "D: a plain class is registered as a component",
      files: {
        [VITE_CONFIG]: register("acme-plain-thing", "/negatives", "PlainClass"),
        [PRODUCT]: importNegatives(["PlainClass"], "acme-plain-thing"),
      },
      // Either diagnostic is a closed build; which plugin reports first is not deterministic.
      fails:
        /Component imports must be standalone components, directives, pipes, or must be NgModules|\[strata\] AOT integrity/,
    },
    {
      label: "D: a non-class export is registered as a component",
      files: {
        [VITE_CONFIG]: register("acme-not-class", "/negatives", "NOT_A_CLASS"),
        [PRODUCT]: importNegatives(["NOT_A_CLASS"], "acme-not-class"),
      },
      fails: /\[strata\] AOT integrity|Type 'number' is not assignable/,
    },
    {
      label: "D: an export that does not exist is registered",
      files: {
        [VITE_CONFIG]: register("acme-ghost-thing", "/negatives", "GhostComponent"),
        [PRODUCT]: importNegatives(["GhostComponent"], "acme-ghost-thing"),
      },
      fails: /GhostComponent|MISSING_EXPORT|is not exported|\[strata\] AOT integrity/,
    },
    {
      label: "unregistered package component used as a client island",
      files: {
        [PRODUCT]: importNegatives(["MismatchedPickerComponent"], "acme-mismatched-picker"),
      },
      fails: /<acme-mismatched-picker> is marked \[strataClient\]/,
    },
    {
      label:
        "E (directive registered as a component): statically indistinguishable, enforced in the browser",
      files: {
        [VITE_CONFIG]: register("acme-directive-only", "/negatives", "DirectiveOnlyDirective"),
        [PRODUCT]: importNegatives(["DirectiveOnlyDirective"], "acme-directive-only"),
      },
      builds: true,
    },
    {
      label: "K: repeated references to one valid component",
      files: {
        [PRODUCT]: (s) =>
          s.replace(
            "<legacy-counter",
            '<acme-product-picker id="third" [productView]="publicProduct" [strataClient]="{ productView: publicProduct }" />\n    <legacy-counter',
          ),
      },
      builds: true,
    },
  ];

  const buildChecks: boolean[] = [];

  for (const scenario of buildCases) {
    workspace.restoreSources();
    workspace.clean();
    for (const [path, content] of Object.entries(scenario.files)) {
      writeConsumerFile(consumerDir, path, content);
    }

    const result = workspace.vite(["build"]);
    const output = sanitize(`${result.stdout}\n${result.stderr}`);

    if (scenario.fails) {
      buildChecks.push(
        check(`${scenario.label}: the production build fails closed`, result.status !== 0),
        check(
          `${scenario.label}: the diagnostic names the cause`,
          scenario.fails.test(output),
          output
            .split("\n")
            .filter((line) => /error|strata|NG\d/i.test(line))
            .slice(0, 4)
            .join(" | "),
        ),
        check(
          `${scenario.label}: nothing deployable was produced and no server marker was printed`,
          !existsSync(dist("analog", "server", "index.mjs")) &&
            SERVER_MARKERS.every((marker) => !output.includes(marker)),
        ),
      );
    } else {
      buildChecks.push(
        check(
          `${scenario.label}: the production build succeeds`,
          result.status === 0,
          output.slice(-600),
        ),
      );

      if (scenario.label.startsWith("E")) {
        // Real build, real registration: the directive reaches the browser only as a refused reference.
        const server = await startNode();
        const directiveCase: RuntimeCase = {
          name: "E: directive registered as a client component (real build, no mutation)",
          mutation: "none — the consumer's source and registry were changed before the build",
          expect: "refused",
          report: ["is not an Angular component"],
        };

        buildChecks.push(
          await checkRuntimeMatrix("Node (directive build)", server.baseUrl, [directiveCase]),
        );
        await server.stop();
        servers.length = 0;
      }
    }
  }
  workspace.restoreSources();
  workspace.clean();
  verdict["buildMatrix"] = all(buildChecks);

  // ------------------------------------------------------------------------
  section("Installed package upgrade, dependency optimization and cache behaviour");

  const upgradeChecks: boolean[] = [];
  const marker = (text: string): "v1" | "v2" | "none" =>
    text.includes(`${PICKER_MARKER}_V2`) ? "v2" : text.includes(PICKER_MARKER) ? "v1" : "none";
  const optimizedDeps = (): string => {
    const directory = join(consumerDir, "node_modules", ".vite", "deps");

    return existsSync(directory)
      ? readdirSync(directory)
          .filter((file) => file.endsWith(".js"))
          .map((file) => readFileSync(join(directory, file), "utf8"))
          .join("\n")
      : "";
  };
  const dev = async (
    label: string,
    args: readonly string[] = [],
  ): Promise<{ ssr: "v1" | "v2" | "none"; prebundle: "v1" | "v2" | "none"; status: number }> => {
    const port = await findFreePort();
    const server = await startServer(
      process.execPath,
      [
        join(consumerDir, "node_modules", "vite", "bin", "vite.js"),
        ...args,
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      { cwd: consumerDir, env, port, readyPath: "/" },
    );
    const page = await httpGet(`${server.baseUrl}/mixed`);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await httpGet(`${server.baseUrl}/mixed`);
    await server.stop();
    console.log(
      `  ·    ${label}: ssr ${marker(page.body)}, browser prebundle ${marker(optimizedDeps())}`,
    );

    return { ssr: marker(page.body), prebundle: marker(optimizedDeps()), status: page.status };
  };

  // Production: the build always reads the installed files.
  workspace.clean({ vite: true });
  upgradeChecks.push(build("production build, v1 installed"));
  upgradeChecks.push(
    check(
      "production build, v1: the browser graph carries the v1 library",
      marker(
        filesIn(["client"])
          .filter((f) => f.endsWith(".js"))
          .map((f) => readFileSync(dist(f), "utf8"))
          .join("\n"),
      ) === "v1",
    ),
  );

  // Dev, clean cache, v1.
  workspace.clean({ vite: true });
  const fresh = await dev("dev, clean Vite cache, v1");

  upgradeChecks.push(
    check(
      "dev with a clean cache serves v1 (SSR) and prebundles v1",
      fresh.ssr === "v1" && fresh.prebundle === "v1",
    ),
  );

  // Dev, warm cache, restart.
  const warm = await dev("dev, warm Vite cache, restart, v1");

  upgradeChecks.push(
    check(
      "dev restart with a warm cache is unchanged",
      warm.ssr === "v1" && warm.prebundle === "v1",
    ),
  );

  // The scenario of the earlier warm-cache observation: the installed file is edited IN PLACE (no
  // npm operation), with a warm optimizer cache.
  const installedIndex = join(
    consumerDir,
    "node_modules",
    WIDGETS_PACKAGE,
    "dist",
    "fesm2022",
    "index.js",
  );
  const originalIndex = readFileSync(installedIndex, "utf8");

  writeFileSync(installedIndex, originalIndex.replaceAll(PICKER_MARKER, `${PICKER_MARKER}_V2`));

  const inPlace = await dev("dev, warm cache, installed file edited in place (no npm)");

  writeFileSync(installedIndex, originalIndex);
  verdict["inPlaceEditStaleBrowserPrebundle"] = inPlace.prebundle === "v1";
  upgradeChecks.push(
    check(
      "SSR reads an in-place edit of an installed file",
      inPlace.ssr === "v2",
      JSON.stringify(inPlace),
    ),
  );
  console.log(
    `  ·    in-place node_modules edit with a warm cache: browser prebundle ${inPlace.prebundle} — ${inPlace.prebundle === "v1" ? "STALE (upstream: Vite's optimizer does not watch node_modules; unsupported, restart with --force)" : "followed the edit"}`,
  );

  // Upgrade with the lockfile untouched (the cached optimizer hash does not move).
  const lockfile = join(consumerDir, "package-lock.json");
  const lockBefore = readFileSync(lockfile, "utf8");
  const upgraded = workspace.installWidgets("v2");

  upgradeChecks.push(
    check("npm upgrade to v2 (--no-save) succeeds", upgraded.status === 0),
    check(
      "the upgrade did not rewrite package-lock.json (the optimizer's lockfile hash is unchanged)",
      readFileSync(lockfile, "utf8") === lockBefore,
    ),
  );

  const stale = await dev("dev, warm cache, v2 installed (lockfile unchanged)");

  console.log(`  ·    classification: SSR ${stale.ssr}, browser prebundle ${stale.prebundle}`);
  upgradeChecks.push(
    check(
      "SSR always reads the installed package (v2) even with a warm cache",
      stale.ssr === "v2",
      JSON.stringify(stale),
    ),
  );
  verdict["warmCacheStaleBrowserPrebundle"] = stale.prebundle === "v1";
  console.log(
    `  ·    reproduced upstream limitation (Vite optimizer cache keyed by lockfile): ${verdict["warmCacheStaleBrowserPrebundle"] ? "YES — the browser prebundle stayed v1" : "no — the prebundle followed the upgrade"}`,
  );

  // `vite --force` re-optimizes dependencies regardless of the cache.
  const forced = await dev("dev, warm cache, v2 installed, `vite --force`", ["--force"]);

  upgradeChecks.push(
    check(
      "`vite --force` after the upgrade prebundles v2",
      forced.ssr === "v2" && forced.prebundle === "v2",
      JSON.stringify(forced),
    ),
  );

  // Clean cache after the upgrade.
  workspace.clean({ vite: true });

  const afterClean = await dev("dev, clean Vite cache, v2");

  upgradeChecks.push(
    check(
      "a clean cache after the upgrade serves and prebundles v2",
      afterClean.ssr === "v2" && afterClean.prebundle === "v2",
    ),
  );

  // Production rebuild after upgrade.
  upgradeChecks.push(build("production rebuild, v2 installed"));
  upgradeChecks.push(
    check(
      "production rebuild: the browser graph carries the v2 library and no v1 marker remains",
      !/STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT(?!_V2)/.test(
        filesIn(["client"])
          .filter((f) => f.endsWith(".js"))
          .map((f) => readFileSync(dist(f), "utf8"))
          .join("\n"),
      ) &&
        marker(
          filesIn(["client"])
            .filter((f) => f.endsWith(".js"))
            .map((f) => readFileSync(dist(f), "utf8"))
            .join("\n"),
        ) === "v2",
    ),
  );

  // Compatibility of the v2 changes with the v1 registration: valid input and export changes.
  const stockPanel = "src/app/product/stock-panel.server-component.ts";

  workspace.restoreSources();
  workspace.clean();
  for (const [path, content] of Object.entries({
    [VITE_CONFIG]: (s: string) =>
      s.replace('"@strata-test/angular-widgets/second"', '"@strata-test/angular-widgets/extra"'),
    [stockPanel]: (s: string) => s.replace("angular-widgets/second", "angular-widgets/extra"),
    [PRODUCT]: (s: string) =>
      s.replace(
        '<acme-product-picker\n      id="package-picker-primary"',
        '<acme-product-picker\n      heading="Heading"\n      id="package-picker-primary"',
      ),
  })) {
    writeConsumerFile(consumerDir, path, content);
  }

  const v2Result = workspace.vite(["build"]);

  upgradeChecks.push(
    check(
      "v2 installed: the new input and the new subpath export are accepted by the same registration shape",
      v2Result.status === 0,
      sanitize(`${v2Result.stdout}\n${v2Result.stderr}`).slice(-900),
    ),
  );

  // Downgrade to v1 without changing the source: the consumer now uses things v1 lacks.
  upgradeChecks.push(
    check("npm downgrade to v1 succeeds", workspace.installWidgets("v1").status === 0),
  );
  workspace.clean();

  const downgrade = workspace.vite(["build"]);
  const downgradeOutput = sanitize(`${downgrade.stdout}\n${downgrade.stderr}`);

  upgradeChecks.push(
    check(
      "L: a package version that lacks the used input or export fails the production build closed",
      downgrade.status !== 0 &&
        /heading|Package subpath|not exported|Failed to resolve|extra/.test(downgradeOutput),
      downgradeOutput
        .split("\n")
        .filter((line) => /error|heading|extra/i.test(line))
        .slice(0, 3)
        .join(" | "),
    ),
  );
  workspace.restoreSources();
  workspace.clean({ vite: true });
  verdict["upgrade"] = all(upgradeChecks);
} catch (error) {
  console.log(
    ` FAIL qualification aborted — ${error instanceof Error ? error.stack : String(error)}`,
  );
  check("qualification completed without an aborting error", false);
} finally {
  await stopAll();
  workspace.dispose();
}

section("Verdict");
for (const [name, passed] of Object.entries(verdict)) {
  if (name === "warmCacheStaleBrowserPrebundle" || name === "inPlaceEditStaleBrowserPrebundle") {
    console.log(`  info ${name}: ${passed}`);
    continue;
  }
  check(name, passed);
}
void RUNTIME_CASES;
finish(TITLE);
