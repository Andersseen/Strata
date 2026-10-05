import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { findFreePort, spawnManaged, waitForHttp } from "../../analog/lib/process.ts";
import type { ManagedProcess } from "../../analog/lib/process.ts";
import { run } from "../../consumer/lib/exec.ts";

import {
  ANGULAR_COMPILER_FINGERPRINT,
  check,
  checkNoBuildTools,
  dirGraph,
  finish,
  graphFilesWith,
  section,
} from "./harness.ts";
import type { OutputGraph } from "./harness.ts";
import { declaresServerOnly } from "./server-only.ts";

/**
 * Shared, private harness of the dogfood gates for real apps consuming the
 * private @strata-sc/server-components package (`pnpm test:www:server-components`,
 * `pnpm test:relay:server-components`): a plain-SSR control build, the
 * production build with hidden source maps, browser/server graph scans by
 * marker and by bundled source module, the Nitro node-server, and the app's
 * own Playwright suite against it. Not a package, not public API.
 */

export interface AppGateConfig {
  readonly title: string;
  /** Absolute app directory; its `dist/` is rebuilt by every build. */
  readonly appDir: string;
  /** Env var the app's Playwright config reads to target an external server. */
  readonly baseUrlEnv: string;
  /** Strings each server-only module emits; must never reach the browser. */
  readonly serverOnlyMarkers: readonly string[];
  /** Strings each client island emits; must reach the browser JS. */
  readonly clientMarkers: readonly string[];
  /** App source modules (as source-map paths end) that must stay server-side. */
  readonly serverModules: readonly string[];
  /**
   * Server modules that assert `import "@strata-sc/server-components/server-only"`.
   * Each must be one of `serverModules`, so the browser/server scans cover it.
   */
  readonly serverOnlyAssertions: readonly string[];
  /** Source modules the browser needs: islands and generated surrogates. */
  readonly clientModules: readonly string[];
  /** Name fragments that would reveal a server-only module as a browser file. */
  readonly serverFileNames: readonly string[];
}

export const all = (results: readonly boolean[]): boolean => results.every(Boolean);

export const jsFiles = (graph: OutputGraph): OutputGraph => ({
  ...graph,
  label: `${graph.label} (.js)`,
  files: graph.files.filter((file) => /\.m?js$/.test(file)),
});

export function createAppGate(config: AppGateConfig) {
  const distDir = join(config.appDir, "dist");
  const verdict: Record<string, boolean> = {};
  const stop = (): never => finish(config.title);

  function build(label: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): void {
    rmSync(distDir, { recursive: true, force: true });

    const result = run("pnpm", ["exec", "vite", "build", ...args], {
      cwd: config.appDir,
      env: { ...process.env, ...env },
    });

    check(`${label}: production build exits 0`, result.status === 0, result.stderr.slice(-2_000));
    if (result.status !== 0) stop();
  }

  const graph = (label: string, dirs: readonly string[]): OutputGraph =>
    dirGraph(label, dirs, () => false, distDir);

  /** Every source module bundled into the graph's JavaScript, from its source maps. */
  function bundledSources(output: OutputGraph): string[] {
    return output.files
      .filter((file) => file.endsWith(".js.map") || file.endsWith(".mjs.map"))
      .flatMap(
        (file) =>
          (JSON.parse(readFileSync(join(distDir, file), "utf8")) as { sources?: string[] })
            .sources ?? [],
      );
  }

  /**
   * Control: with the plugin off the app is plain SSR, and every server-only
   * marker and module must reach the browser; otherwise the scans prove nothing.
   */
  function control(): void {
    section("Control build: plain SSR (STRATA_SERVER_COMPONENTS=off)");
    build("control", ["--sourcemap", "hidden"], { STRATA_SERVER_COMPONENTS: "off" });

    const browser = graph("dist/client", ["client"]);
    const sources = bundledSources(browser);

    verdict["control leaks (scanner sees server code)"] = all([
      ...config.serverOnlyMarkers.map((marker) =>
        check(
          `control leaks ${marker} into browser JS`,
          graphFilesWith(jsFiles(browser), marker).length > 0,
        ),
      ),
      ...config.serverModules.map((module) =>
        check(
          `control bundles ${module} for the browser`,
          sources.some((source) => source.endsWith(module)),
        ),
      ),
    ]);
  }

  function checkBrowserGraph(output: OutputGraph, sourceMaps: boolean): boolean {
    section(`Browser graph (${output.label})`);

    const results = [
      ...config.serverOnlyMarkers.map((marker) => {
        const found = graphFilesWith(output, marker);

        return check(`${marker} absent`, found.length === 0, found.join(", "));
      }),
      ...config.clientMarkers.map((marker) => {
        const found = graphFilesWith(jsFiles(output), marker);

        return check(
          `${marker} present in browser JS (${found.join(", ")})`,
          found.length > 0,
          "not found",
        );
      }),
      (() => {
        const leaked = output.files.filter((file) =>
          config.serverFileNames.some((name) => file.toLowerCase().includes(name)),
        );

        return check(
          "no browser file is named after a server-only module",
          leaked.length === 0,
          leaked.join(", "),
        );
      })(),
      check(
        "@angular/compiler absent from the browser output",
        graphFilesWith(output, ANGULAR_COMPILER_FINGERPRINT).length === 0,
      ),
    ];

    checkNoBuildTools(output);

    if (sourceMaps) {
      const sources = bundledSources(output);

      console.log(`browser chunks bundle ${sources.length} source modules`);
      results.push(check("browser source maps list the bundled modules", sources.length > 0));

      for (const module of [
        ...config.serverModules,
        "packages/server-components/dist/vite.js",
        // The assertion entry: consumed by the build, never a browser dependency.
        "packages/server-components/dist/server-only.js",
      ]) {
        results.push(
          check(
            `module ${module} not bundled for the browser`,
            !sources.some((source) => source.endsWith(module)),
          ),
        );
      }

      for (const module of config.clientModules) {
        results.push(
          check(
            `module ${module} bundled for the browser`,
            sources.some((source) => source.endsWith(module)),
          ),
        );
      }
    }

    return all(results);
  }

  function checkServerGraph(output: OutputGraph): boolean {
    section(`Server graph (${output.label})`);

    return all(
      [...config.serverOnlyMarkers, ...config.clientMarkers].map((marker) => {
        const found = graphFilesWith(output, marker);

        return check(`${marker} present (${found.join(", ")})`, found.length > 0, "not found");
      }),
    );
  }

  /** The app's own server-only assertions: declared in source, and scanned as server modules. */
  function checkAssertions(): boolean {
    section('Server-only assertions (import "@strata-sc/server-components/server-only")');

    return all(
      config.serverOnlyAssertions.flatMap((module) => [
        check(`${module} declares the assertion`, declaresServerOnly(join(config.appDir, module))),
        check(`${module} is scanned as a server module`, config.serverModules.includes(module)),
      ]),
    );
  }

  /** Node build with hidden source maps (emitted .js unchanged), then both graphs. */
  function nodeBuild(): void {
    verdict["server-only assertions declared"] = checkAssertions();

    section("Node build: vite build --sourcemap hidden");
    build("Node", ["--sourcemap", "hidden"]);

    verdict["node browser graph"] = checkBrowserGraph(
      graph("dist/client, dist/analog/public", ["client", "analog/public"]),
      true,
    );
    verdict["node server graph"] = checkServerGraph(
      graph("dist/ssr, dist/analog/server", ["ssr", "analog/server"]),
    );

    const ssrSources = bundledSources(graph("dist/ssr", ["ssr"]));

    verdict["node server modules"] = all(
      config.serverModules.map((module) =>
        check(
          `module ${module} bundled for SSR`,
          ssrSources.some((source) => source.endsWith(module)),
        ),
      ),
    );
  }

  /** Runs the app's own Playwright suite against `baseUrl`, output streamed. */
  async function runPlaywright(baseUrl: string, runtime: string): Promise<boolean> {
    section(`${runtime}: Playwright — hydration, interaction, Angular errors`);

    const status = await new Promise<number>((resolve) => {
      const child = spawn("pnpm", ["exec", "playwright", "test", "--reporter=list"], {
        cwd: config.appDir,
        env: { ...process.env, [config.baseUrlEnv]: baseUrl },
        stdio: "inherit",
      });

      child.on("exit", (code) => resolve(code ?? 1));
    });

    return check(`${runtime}: Playwright suite passes`, status === 0, `exit ${status}`);
  }

  /** Waits for `server`, runs `ssr` then Playwright, and always stops it. */
  async function withServer(
    server: ManagedProcess,
    baseUrl: string,
    runtime: string,
    timeoutMs: number,
    ssr: (baseUrl: string, runtime: string) => Promise<boolean>,
  ): Promise<{ ssr: boolean; e2e: boolean }> {
    try {
      await waitForHttp(`${baseUrl}/`, server, timeoutMs);

      const ssrPassed = await ssr(baseUrl, runtime);
      const e2e = await runPlaywright(baseUrl, runtime);

      return { ssr: ssrPassed, e2e };
    } catch (error) {
      check(`${runtime} starts`, false, `${String(error)}\n${server.output().slice(-2_000)}`);

      return { ssr: false, e2e: false };
    } finally {
      await server.stop();
    }
  }

  /** The built Nitro `node-server` on a free port: SSR checks, then Playwright. */
  async function nodeServer(ssr: (baseUrl: string, runtime: string) => Promise<boolean>) {
    const port = await findFreePort();
    const server = spawnManaged(process.execPath, ["dist/analog/server/index.mjs"], {
      cwd: config.appDir,
      env: { PORT: String(port), NITRO_PORT: String(port) },
    });
    const result = await withServer(
      server,
      `http://127.0.0.1:${port}`,
      "Nitro node-server",
      30_000,
      ssr,
    );

    verdict["node SSR"] = result.ssr;
    verdict["node hydration + interaction (Playwright)"] = result.e2e;
  }

  function report(): never {
    section("Verdict");

    for (const [name, passed] of Object.entries(verdict)) {
      console.log(`${passed ? "  ok  " : " FAIL "} ${name}`);
    }

    return stop();
  }

  return {
    distDir,
    verdict,
    stop,
    build,
    control,
    nodeBuild,
    nodeServer,
    checkBrowserGraph,
    checkServerGraph,
    withServer,
    report,
  };
}
