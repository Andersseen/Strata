import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build as viteBuild, createServer } from "vite";
import type { InlineConfig } from "vite";

import { findFilesContaining, listFiles } from "../analog/lib/scan.ts";

import { check, finish, section } from "./lib/harness.ts";

/**
 * `pnpm test:server-component-optimized-deps`: the server-only firewall
 * against the dependency optimizer of Vite's dev server and against
 * production builds, with REAL installed packages
 * (docs/research/server-component-optimized-dependency-firewall-v09.md).
 *
 * `@acme/server-kit` (tests/server-component-optimized-deps/kit) and the
 * plugin package are packed and installed with npm into a directory OUTSIDE
 * the repository; the app runs the INSTALLED plugin. The kit exposes safe
 * entries, a server-only entry, barrels and chains re-exporting it, a dynamic
 * import of it, conditional exports and a type-only re-export.
 *
 * Every refusal is checked for the intended Strata diagnostic, so a build or
 * request that fails for another reason (syntax error, unresolved package)
 * cannot pass as a security result. A positive control proves the private
 * markers exist and are served when the firewall is off.
 *
 * It also qualifies the package graph itself
 * (docs/research/installed-package-graph-hardening.md): re-export forms, cycles,
 * an Angular Package Format layout, and the access that never parses a module
 * (`?raw`, `?url`, workers, `new URL`), each with its firewall-off exposure.
 */

process.on("unhandledRejection", (reason) => {
  console.log(` FAIL unhandled rejection: ${String((reason as Error)?.message).slice(0, 300)}`);
  console.log(
    String((reason as Error)?.stack)
      .split("\n")
      .slice(0, 12)
      .join("\n"),
  );
  process.exit(1);
});

const TITLE = "Server-only firewall vs the dependency optimizer";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIT = "@acme/server-kit";
const APF = "@acme/apf-kit";

const PUBLIC = [
  "STRATA_FIXTURE_PUBLIC_ROOT",
  "STRATA_FIXTURE_PUBLIC_FORMAT",
  "STRATA_FIXTURE_PUBLIC_TYPES",
  "STRATA_FIXTURE_PUBLIC_LAZY",
  "STRATA_FIXTURE_PUBLIC_COND_BROWSER",
  "STRATA_FIXTURE_PUBLIC_CYCLE",
  "STRATA_FIXTURE_PUBLIC_INLINE_TYPES",
  "STRATA_FIXTURE_PUBLIC_APF",
];
const PRIVATE = [
  "STRATA_FIXTURE_SERVER_ONLY",
  "STRATA_FIXTURE_PRIVATE_IMPL",
  "STRATA_FIXTURE_PRIVATE_COND_NODE",
];
const DIAGNOSTIC = "[strata] Server-only module entered the browser graph";

interface Scenario {
  readonly name: string;
  readonly code: string;
  /** `safe`: allowed with the public marker; `forbidden`: refused with the Strata diagnostic naming `names`. */
  readonly expect: "safe" | "forbidden";
  readonly names?: readonly string[];
  readonly marker?: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "package root",
    code: `import { PUBLIC_ROOT } from "${KIT}"; console.log(PUBLIC_ROOT);`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_ROOT",
  },
  {
    name: "safe subpath",
    code: `import { format } from "${KIT}/format"; console.log(format("x"));`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_FORMAT",
  },
  {
    name: "safe barrel (re-exports only safe modules)",
    code: `import { format, PUBLIC_ROOT } from "${KIT}/safe-barrel"; console.log(format(PUBLIC_ROOT));`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_ROOT",
  },
  {
    name: "type-only re-export",
    code: `import type { reveal } from "${KIT}/types"; import { PUBLIC_TYPES } from "${KIT}/types"; console.log(PUBLIC_TYPES);`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_TYPES",
  },
  {
    name: "browser conditional export",
    code: `import { COND } from "${KIT}/cond"; console.log(COND);`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_COND_BROWSER",
  },
  {
    name: "server-only subpath",
    code: `import { reveal } from "${KIT}/secret"; console.log(reveal());`,
    expect: "forbidden",
    names: ["node_modules/@acme/server-kit/secret.js"],
  },
  {
    name: "barrel re-exporting server-only (safe named export selected)",
    code: `import { format } from "${KIT}/barrel"; console.log(format("x"));`,
    expect: "forbidden",
    names: ["node_modules/@acme/server-kit/secret.js", "node_modules/@acme/server-kit/barrel.js"],
  },
  {
    name: "chained barrel",
    code: `import { format } from "${KIT}/chain"; console.log(format("x"));`,
    expect: "forbidden",
    names: [
      "node_modules/@acme/server-kit/secret.js",
      "node_modules/@acme/server-kit/barrel.js",
      "node_modules/@acme/server-kit/chain.js",
    ],
  },
  {
    name: "dynamic import of server-only",
    code: `import { loadSecret } from "${KIT}/lazy"; loadSecret().then(console.log);`,
    expect: "forbidden",
    names: ["node_modules/@acme/server-kit/secret.js"],
  },
];

const INSTALLED = "node_modules/@acme/server-kit";
const INSTALLED_APF = "node_modules/@acme/apf-kit/fesm2022";

/** Re-export forms and package layouts. Dev and production, against the installed tarballs. */
const GRAPH_SCENARIOS: readonly Scenario[] = [
  {
    name: "safe re-export cycle terminates",
    code: `import { CYCLE_A } from "${KIT}/cycle-safe"; console.log(CYCLE_A);`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_CYCLE",
  },
  {
    name: "inline type-only re-export of a server-only module (TypeScript source)",
    code: `import { PUBLIC_INLINE_TYPES } from "${KIT}/inline-types"; console.log(PUBLIC_INLINE_TYPES);`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_INLINE_TYPES",
  },
  {
    name: "browser condition of a barrel whose node condition is server-only",
    code: `import { COND } from "${KIT}/cond-barrel"; console.log(COND);`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_COND_BROWSER",
  },
  {
    name: "APF primary entry re-exporting a shared chunk",
    code: `import { PUBLIC_APF } from "${APF}"; console.log(PUBLIC_APF);`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_APF",
  },
  {
    name: "APF safe secondary entry of a package with a server-only one",
    code: `import { apfLabel } from "${APF}/safe"; console.log(apfLabel());`,
    expect: "safe",
    marker: "STRATA_FIXTURE_PUBLIC_APF",
  },
  {
    name: "named re-export of a barrel",
    code: `import { format } from "${KIT}/named-barrel"; console.log(format("x"));`,
    expect: "forbidden",
    names: [`${INSTALLED}/named-barrel.js`, `${INSTALLED}/barrel.js`, `${INSTALLED}/secret.js`],
  },
  {
    name: "namespace re-export",
    code: `import { format } from "${KIT}/namespace-barrel"; console.log(format("x"));`,
    expect: "forbidden",
    names: [`${INSTALLED}/namespace-barrel.js`, `${INSTALLED}/secret.js`],
  },
  {
    name: "re-export cycle with a server-only module behind it",
    code: `import { A } from "${KIT}/cycle-secret"; console.log(A);`,
    expect: "forbidden",
    names: [
      `${INSTALLED}/cycle-secret-a.js`,
      `${INSTALLED}/cycle-secret-b.js`,
      `${INSTALLED}/secret.js`,
    ],
  },
  {
    name: "package subpath import (#secret) inside a barrel",
    code: `import { reveal } from "${KIT}/subpath-import"; console.log(reveal());`,
    expect: "forbidden",
    names: [`${INSTALLED}/subpath-import.js`, `${INSTALLED}/secret.js`],
  },
  {
    name: "re-export across packages",
    code: `import { apfReveal } from "${KIT}/foreign"; console.log(apfReveal());`,
    expect: "forbidden",
    names: [`${INSTALLED}/foreign.js`, `${INSTALLED_APF}/acme-apf-kit-server.mjs`],
  },
  {
    name: "CommonJS entry requiring the assertion",
    code: `import { LEGACY } from "${KIT}/legacy"; console.log(LEGACY);`,
    expect: "forbidden",
    names: [`${INSTALLED}/legacy.cjs`],
  },
  {
    name: "APF server-only secondary entry",
    code: `import { apfReveal } from "${APF}/server"; console.log(apfReveal());`,
    expect: "forbidden",
    names: [`${INSTALLED_APF}/acme-apf-kit-server.mjs`],
  },
  {
    name: "APF barrel entry (safe named export selected)",
    code: `import { PUBLIC_APF } from "${APF}/barrel"; console.log(PUBLIC_APF);`,
    expect: "forbidden",
    names: [`${INSTALLED_APF}/acme-apf-kit-barrel.mjs`, `${INSTALLED_APF}/acme-apf-kit-server.mjs`],
  },
];

const WORKER_IMPORTING = `import W from "./worker.ts?worker"; new W();`;
const APP_SECRET = [
  `import "@strata-sc/server-components/server-only";`,
  `globalThis.strataFixtureApp = "STRATA_FIXTURE_SERVER_ONLY";`,
].join("\n");

interface Access {
  readonly name: string;
  readonly code: string;
  /** Further modules of the app, by `src/`-relative name. */
  readonly files?: Readonly<Record<string, string>>;
  /** Whether the dev server takes part: a worker is an ordinary module graph there. */
  readonly dev?: boolean;
}

/**
 * Access that never parses the module, so its own assertion cannot run, and
 * graphs Vite bundles without the app's plugins. Every one of these shipped the
 * private markers before this suite covered it, and still does with the firewall
 * off: that exposure is measured below as the negative control.
 */
const ACCESS_SCENARIOS: readonly Access[] = [
  {
    name: "?raw of a server-only subpath",
    code: `import s from "${KIT}/secret?raw"; console.log(s);`,
    dev: true,
  },
  {
    name: "?url of a server-only subpath",
    code: `import s from "${KIT}/secret?url"; console.log(s);`,
    dev: true,
  },
  {
    name: "?url&inline of a server-only subpath",
    code: `import s from "${KIT}/secret?url&inline"; console.log(s);`,
  },
  {
    name: "dynamic ?raw",
    code: `import("${KIT}/secret?raw").then(console.log);`,
    dev: true,
  },
  {
    name: "?raw through a node_modules path",
    code: `import s from "/node_modules/@acme/server-kit/secret.js?raw"; console.log(s);`,
    dev: true,
  },
  {
    name: "import.meta.glob with ?raw",
    code: `console.log(import.meta.glob("/node_modules/@acme/server-kit/secret.js", { query: "?raw", eager: true }));`,
    dev: true,
  },
  {
    name: "new URL of a package module",
    code: `console.log(new URL("../node_modules/@acme/server-kit/secret.js", import.meta.url));`,
  },
  {
    name: "new URL of an app module",
    code: `console.log(new URL("./app-secret.ts", import.meta.url));`,
    files: { "app-secret.ts": APP_SECRET },
  },
  { name: "?worker of a package module", code: `import W from "${KIT}/effect?worker"; new W();` },
  {
    name: "?worker&inline of a package module",
    code: `import W from "${KIT}/effect?worker&inline"; new W();`,
  },
  {
    name: "new Worker of a package module",
    code: `new Worker(new URL("../node_modules/@acme/server-kit/effect.js", import.meta.url), { type: "module" });`,
  },
  {
    name: "new Worker of an app module",
    code: `new Worker(new URL("./app-secret.ts", import.meta.url), { type: "module" });`,
    files: { "app-secret.ts": APP_SECRET },
  },
  {
    name: "app worker importing a package module",
    code: WORKER_IMPORTING,
    files: { "worker.ts": `import "${KIT}/effect";` },
  },
  {
    name: "app worker importing a package module with ?raw",
    code: WORKER_IMPORTING,
    files: { "worker.ts": `import s from "${KIT}/secret?raw"; console.log(s);` },
  },
  {
    name: "app worker importing an app module",
    code: WORKER_IMPORTING,
    files: { "worker.ts": `import "./app-secret.ts";`, "app-secret.ts": APP_SECRET },
  },
];

/** Allowed access: the firewall must not cost a worker or a URL that reaches nothing forbidden. */
const LEGAL_ACCESS: readonly Access[] = [
  {
    name: "?raw of a safe subpath",
    code: `import s from "${KIT}/format?raw"; console.log(s);`,
  },
  {
    name: "worker importing a safe subpath",
    code: WORKER_IMPORTING,
    files: { "worker.ts": `import { format } from "${KIT}/format"; console.log(format("x"));` },
  },
  {
    name: "new URL of a safe package module",
    code: `console.log(new URL("../node_modules/@acme/server-kit/format.js", import.meta.url));`,
  },
];

// ---------------------------------------------------------------------------
// Environment: packed packages installed outside the repository

// Real path: macOS links the temp directory, and Vite reports resolved ids.
const work = realpathSync(mkdtempSync(join(tmpdir(), "strata-optimized-deps-")));
const env = { ...process.env };

for (const key of Object.keys(env)) if (/^(npm_|pnpm_)/i.test(key)) delete env[key];
// Keep npm's cache isolated too: the default user cache may not be writable in
// CI or managed workspaces, and the firewall test needs no shared cache state.
env.NPM_CONFIG_USERCONFIG = join(work, ".npmrc");
env.NPM_CONFIG_CACHE = join(work, "npm-cache");

const npm = (cwd: string, ...args: string[]): string =>
  execFileSync("npm", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function pack(packageDir: string): string {
  const out = npm(packageDir, "pack", "--silent", "--pack-destination", join(work, "tarballs"))
    .trim()
    .split("\n")
    .at(-1) as string;

  return join(work, "tarballs", out);
}

mkdirSync(join(work, "tarballs"), { recursive: true });
writeFileSync(join(work, ".npmrc"), "");

if (!existsSync(join(repoRoot, "packages/server-components/dist/vite.js"))) {
  console.error(
    "Build @strata-sc/server-components first: pnpm --filter @strata-sc/server-components build",
  );
  process.exit(1);
}

const kitTarball = pack(join(repoRoot, "tests/server-component-optimized-deps/kit"));
const apfTarball = pack(join(repoRoot, "tests/server-component-optimized-deps/apf-kit"));
const pluginTarball = pack(join(repoRoot, "packages/server-components"));

/** An app with the kit and the plugin installed from tarballs; vite/typescript are its peers (linked, offline). */
function createApp(name: string, kitMode: "packed" | "linked", html = false): string {
  const app = join(work, name);

  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name, private: true, type: "module" }));
  // With an HTML entry Vite scans the app at start and pre-bundles what it finds before any request.
  if (html)
    writeFileSync(join(app, "index.html"), `<script type="module" src="/src/entry.ts"></script>`);

  if (kitMode === "linked") {
    const linkedKit = join(work, `${name}-kit`);

    cpSync(join(repoRoot, "tests/server-component-optimized-deps/kit"), linkedKit, {
      recursive: true,
    });
    npm(
      app,
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--legacy-peer-deps",
      `file:${linkedKit}`,
      apfTarball,
      pluginTarball,
    );
  } else {
    npm(
      app,
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--legacy-peer-deps",
      kitTarball,
      apfTarball,
      pluginTarball,
    );
  }

  // The plugin's peers, resolved from the workspace's own copies (offline).
  const peers = ["vite", "typescript", "@angular/core", "@angular/compiler"];

  for (const peer of peers) {
    const target = join(repoRoot, "packages/server-components/node_modules", peer);

    mkdirSync(dirname(join(app, "node_modules", peer)), { recursive: true });
    symlinkSync(target, join(app, "node_modules", peer), "dir");
  }

  return app;
}

async function installedPlugin(app: string): Promise<(options: object) => object> {
  const url = pathToFileURL(
    join(app, "node_modules/@strata-sc/server-components/dist/vite.js"),
  ).href;

  const module = (await import(url)) as { strataServerComponents: (options: object) => object };

  return module.strataServerComponents;
}

// ---------------------------------------------------------------------------
// Dev server probe

interface DevResult {
  readonly refused: boolean;
  readonly statuses: readonly number[];
  readonly served: readonly string[];
  readonly optimized: boolean;
  readonly privateServed: readonly string[];
  /** Bodies of the 4xx/5xx responses: what the browser receives when a module is refused. */
  readonly errorBodies: string;
  readonly publicServed: readonly string[];
  readonly logs: string;
  readonly startupError?: string;
  readonly startupMs: number;
  readonly crawlMs: number;
}

interface DevOptions {
  readonly enabled?: boolean;
  readonly cold?: boolean;
  readonly optimizeDeps?: NonNullable<InlineConfig["optimizeDeps"]>;
  /** URLs a page could request directly, with no importer. */
  readonly direct?: readonly string[];
}

async function dev(app: string, code: string, options: DevOptions = {}): Promise<DevResult> {
  const { enabled = true, cold = true, optimizeDeps = {}, direct = [] } = options;
  const strata = await installedPlugin(app);
  const logs: string[] = [];

  writeFileSync(join(app, "src/entry.ts"), code);
  if (cold) rmSync(join(app, "node_modules/.vite"), { recursive: true, force: true });

  const started = performance.now();
  let server;

  try {
    server = await createServer({
      root: app,
      configFile: false,
      server: { port: 0, host: "127.0.0.1" },
      optimizeDeps,
      customLogger: {
        info() {},
        warn: (message) => void logs.push(message),
        warnOnce() {},
        error: (message) => void logs.push(message),
        clearScreen() {},
        hasErrorLogged: () => false,
        hasWarned: false,
      },
      plugins: [strata({ root: app, sourceDir: "src", generatedDir: "src/.strata", enabled })],
    } as InlineConfig);
    await server.listen();
  } catch (error) {
    return {
      refused: true,
      statuses: [],
      served: [],
      optimized: false,
      privateServed: [],
      errorBodies: "",
      publicServed: [],
      logs: logs.join("\n"),
      startupError: String((error as Error).message),
      startupMs: performance.now() - started,
      crawlMs: 0,
    };
  }

  const startupMs = performance.now() - started;
  const base = (server.resolvedUrls?.local[0] ?? "").replace(/\/$/, "");
  const crawlStarted = performance.now();
  const queue = ["/src/entry.ts", ...direct];
  const seen = new Map<string, number>();
  let bodies = "";
  let errorBodies = "";

  while (queue.length > 0 && seen.size < 80) {
    const url = queue.shift() as string;

    if (seen.has(url)) continue;

    const response = await fetch(base + url);
    const text = await response.text();

    seen.set(url, response.status);
    bodies += text;

    if (response.status >= 400) {
      errorBodies += text;
      continue;
    }

    for (const match of text.matchAll(/(?:from|import\()\s*["'](\/[^"']+)["']/g)) {
      queue.push(match[1] as string);
    }
  }

  // Let an optimizer run that a late discovery started settle, then fail or finish.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await server.close();

  const statuses = [...seen.values()];

  return {
    refused: statuses.some((status) => status >= 400),
    statuses,
    served: [...seen.keys()],
    optimized: [...seen.keys()].some((url) => url.includes("/.vite/deps/")),
    privateServed: PRIVATE.filter((marker) => bodies.includes(marker)),
    errorBodies,
    publicServed: PUBLIC.filter((marker) => bodies.includes(marker)),
    logs: logs.join("\n"),
    startupMs,
    crawlMs: performance.now() - crawlStarted,
  };
}

/** The diagnostic without the JavaScript stack behind it (a stack names the machine's own paths). */
const messageOf = (text: string): string => {
  const at = text.indexOf("[strata]");

  // Vite's terminal logger appends its own `Plugin:` / `File:` lines and a code frame to the message,
  // and an uncaught optimizer rejection prints Node's own `file:///…` header after a served body.
  return (
    (at === -1 ? text : text.slice(at)).split(/\n\s+(?:at |Plugin: |File: )|\nfile:\/\//)[0] ?? text
  );
};

function checkScenario(
  label: string,
  scenario: Scenario,
  result: DevResult,
  linked = false,
): boolean {
  const expected = (scenario.names ?? []).map((name) => (linked ? basename(name) : name));
  const diagnostics = `${result.logs}\n${result.startupError ?? ""}`;

  if (scenario.expect === "safe") {
    return [
      check(`${label}: allowed`, !result.refused, `statuses ${result.statuses.join(",")}`),
      check(
        `${label}: public marker served`,
        scenario.marker === undefined || result.publicServed.includes(scenario.marker),
      ),
      check(
        `${label}: no private marker`,
        result.privateServed.length === 0,
        result.privateServed.join(","),
      ),
    ].every(Boolean);
  }

  return [
    check(`${label}: refused`, result.refused),
    check(
      `${label}: Strata diagnostic (not a syntax/resolve/config failure)`,
      diagnostics.includes(DIAGNOSTIC),
    ),
    check(
      `${label}: names ${scenario.names?.map((name) => name.split("/").at(-1)).join(", ")}`,
      expected.every((name) => diagnostics.includes(name)),
    ),
    check(
      `${label}: browser error payload carries no frame, source or machine path`,
      !result.errorBodies.includes(work) &&
        !result.errorBodies.includes(repoRoot) &&
        !/"frame":"[^"]/.test(result.errorBodies) &&
        !/pluginCode/.test(result.errorBodies),
    ),
    check(
      `${label}: no private marker served`,
      result.privateServed.length === 0,
      result.privateServed.join(","),
    ),
    check(
      `${label}: no absolute path in the diagnostic`,
      !messageOf(diagnostics).includes(work) && !messageOf(diagnostics).includes(repoRoot),
    ),
  ].every(Boolean);
}

// ---------------------------------------------------------------------------
// Dev server as a child process: a scanned or included dependency is
// pre-bundled at start, before any request, and a refused run ends the process.

function startupIn(
  appDir: string,
  code: string,
  optimizeDeps: object = {},
): Promise<{ status: number | null; output: string }> {
  const script = join(appDir, "serve.mjs");
  const viteUrl = pathToFileURL(join(appDir, "node_modules/vite/dist/node/index.js")).href;
  const pluginUrl = pathToFileURL(
    join(appDir, "node_modules/@strata-sc/server-components/dist/vite.js"),
  ).href;

  writeFileSync(
    script,
    [
      `import { createServer } from "${viteUrl}";`,
      `import { strataServerComponents } from "${pluginUrl}";`,
      `const root = process.cwd();`,
      `const s = await createServer({ root, configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1" },`,
      `  optimizeDeps: ${JSON.stringify(optimizeDeps)},`,
      `  plugins: [strataServerComponents({ root, sourceDir: "src", generatedDir: "src/.strata" })] });`,
      `await s.listen();`,
      `const base = s.resolvedUrls.local[0].replace(/\\/$/, "");`,
      `const seen = new Set(); const queue = ["/src/entry.ts"];`,
      `while (queue.length) { const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);`,
      `  const r = await fetch(base + u); const t = await r.text(); console.log("STATUS", r.status, u);`,
      `  console.log("BODY", t);`,
      `  if (r.status >= 400) continue;`,
      `  for (const m of t.matchAll(/(?:from|import\\()\\s*["'](\\/[^"']+)["']/g)) queue.push(m[1]); }`,
      `await s.close();`,
    ].join("\n"),
  );
  writeFileSync(join(appDir, "src/entry.ts"), code);
  rmSync(join(appDir, "node_modules/.vite"), { recursive: true, force: true });

  return new Promise((resolve) => {
    const child = spawn("node", [script], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);

    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

function checkStartup(
  label: string,
  scenario: Scenario,
  result: { status: number | null; output: string },
  linked = false,
): boolean {
  const expected = (scenario.names ?? []).map((name) => (linked ? basename(name) : name));
  const leaked = PRIVATE.filter((marker) => result.output.includes(marker));

  if (scenario.expect === "safe") {
    return [
      check(
        `${label}: served`,
        result.status === 0 && !/STATUS (4|5)\d\d/.test(result.output),
        `exit ${result.status}`,
      ),
      check(`${label}: no private marker`, leaked.length === 0, leaked.join(",")),
    ].every(Boolean);
  }

  const message = messageOf(result.output);

  // Two orderings, both closed. The optimizer's rejection ends the process (Vite
  // does not catch it), or the import is refused first and the rejection follows
  // if the server stays up. This harness closes it after the crawl.
  const exited = result.status !== 0 && result.status !== null;
  const refusedAtImport = /STATUS 500 \/src\/entry\.ts/.test(result.output);
  const refusedDeeper = /STATUS 5\d\d \/node_modules\/\.vite\/deps\//.test(result.output);

  return [
    check(
      `${label}: refused before anything forbidden is served`,
      exited || refusedAtImport || refusedDeeper,
      `exit ${result.status}`,
    ),
    check(
      `${label}: Strata diagnostic names the module`,
      message.includes(DIAGNOSTIC) && expected.every((name) => message.includes(name)),
    ),
    check(
      `${label}: no absolute path in the diagnostic`,
      !message.includes(work) && !message.includes(repoRoot),
    ),
    check(`${label}: no private marker in output`, leaked.length === 0, leaked.join(",")),
  ].every(Boolean);
}

// ---------------------------------------------------------------------------
// Run

const verdict: Record<string, boolean> = {};
const app = createApp("app-packed", "packed");

section("Positive control: firewall off, the private markers are served by the dev optimizer");
{
  const control = await dev(app, SCENARIOS[5]?.code ?? "", { enabled: false });

  verdict["control: markers exist and are served without the firewall"] = [
    check("optimized dependency chunk served", control.optimized),
    check(
      "server-only marker served",
      control.privateServed.includes("STRATA_FIXTURE_SERVER_ONLY"),
    ),
    check(
      "private implementation marker served",
      control.privateServed.includes("STRATA_FIXTURE_PRIVATE_IMPL"),
    ),
  ].every(Boolean);
}

for (const mode of ["cold cache", "warm cache"] as const) {
  section(`Dev, ordinary discovery, ${mode}`);

  let all = true;

  for (const scenario of SCENARIOS) {
    // A warm run follows a cold run of the same entry: the cache dir is kept.
    if (mode === "warm cache") await dev(app, scenario.code, { cold: true });

    const result = await dev(app, scenario.code, { cold: mode === "cold cache" });

    all = checkScenario(scenario.name, scenario, result) && all;
    if (scenario.expect === "safe") {
      all = check(`${scenario.name}: processed by the optimizer`, result.optimized) && all;
    }
  }

  verdict[`dev ${mode}`] = all;
}

section("Dev, forced optimization (optimizeDeps.force)");
{
  let all = true;

  for (const scenario of SCENARIOS) {
    all =
      checkScenario(
        scenario.name,
        scenario,
        await dev(app, scenario.code, { optimizeDeps: { force: true } }),
      ) && all;
  }

  verdict["dev force"] = all;
}

section(
  "Dev, startup scan (HTML entry): Vite pre-bundles the scanned dependencies before any request",
);
{
  const scanned = createApp("app-scanned", "packed", true);
  let all = true;

  for (const scenario of SCENARIOS) {
    all =
      checkStartup(`scan ${scenario.name}`, scenario, await startupIn(scanned, scenario.code)) &&
      all;
  }

  verdict["dev startup scan"] = all;
}

section("Dev, optimizeDeps.include of the entry (pre-bundled at start)");
{
  let all = true;

  for (const scenario of SCENARIOS) {
    const subpath = scenario.code.match(/"(@acme\/server-kit[^"]*)"/)?.[1] as string;

    all =
      checkStartup(
        `include ${scenario.name}`,
        scenario,
        await startupIn(app, scenario.code, { include: [subpath] }),
      ) && all;
  }

  verdict["dev include"] = all;
}

section("Dev, optimizeDeps.exclude (served unbundled: the module-graph check refuses it)");
{
  let all = true;

  for (const scenario of SCENARIOS.filter(
    (entry) => entry.name.startsWith("server-only subpath") || entry.name === "chained barrel",
  )) {
    const result = await dev(app, scenario.code, { optimizeDeps: { exclude: [KIT] } });

    all = check(`${scenario.name}: refused`, result.refused) && all;
    all =
      check(
        `${scenario.name}: no private marker (error payload included)`,
        result.privateServed.length === 0,
        result.privateServed.join(","),
      ) && all;
  }

  verdict["dev exclude"] = all;
}

section("Dev, package graph: re-export forms and APF layout, cold cache");
{
  let all = true;

  for (const scenario of GRAPH_SCENARIOS) {
    all = checkScenario(scenario.name, scenario, await dev(app, scenario.code)) && all;
  }

  verdict["dev package graph"] = all;
}

section("Dev, access that never parses the module");
{
  const results: boolean[] = [];

  for (const scenario of ACCESS_SCENARIOS.filter((entry) => entry.dev)) {
    const open = await dev(app, scenario.code, { enabled: false });
    const closed = await dev(app, scenario.code);
    const exposed = /\?url/.test(scenario.name)
      ? open.logs.length >= 0 && !open.refused
      : open.privateServed.length > 0;

    results.push(
      check(`${scenario.name}: exposed with the firewall off (control)`, exposed),
      checkScenario(
        scenario.name,
        { ...scenario, expect: "forbidden", names: [`${INSTALLED}/secret.js`] },
        closed,
      ),
    );
  }

  const urls = ["raw", "url", "inline"].map((query) => `/node_modules/${KIT}/secret.js?${query}`);
  const open = await dev(app, "console.log(1);", { enabled: false, direct: urls });
  const closed = await dev(app, "console.log(1);", { direct: urls });

  results.push(
    check(
      "direct request for ?raw, no importer: served with the firewall off (control)",
      open.privateServed.length > 0,
    ),
    check(
      "direct request for ?raw, ?url and ?inline: refused, the entry itself still served",
      closed.statuses.filter((status) => status === 500).length === urls.length &&
        closed.statuses.includes(200),
      closed.statuses.join(","),
    ),
    check("direct request: no private marker served", closed.privateServed.length === 0),
    check(
      "direct request: the payload carries no frame, source or machine path",
      !closed.errorBodies.includes(work) && !/"frame":"[^"]/.test(closed.errorBodies),
    ),
  );
  verdict["dev access without a parse"] = results.every(Boolean);
}

section("Failures that are not the firewall do not count as a firewall pass");
{
  const syntax = await dev(app, `import { x } from "${KIT}/broken"; console.log(x);`);
  const missing = await dev(app, `import { x } from "@acme/does-not-exist"; console.log(x);`);

  verdict["unrelated failures are distinguishable"] = [
    check(
      "syntax error in a package: not the Strata diagnostic",
      !`${syntax.logs}${syntax.startupError ?? ""}`.includes(DIAGNOSTIC),
    ),
    check(
      "unresolved package: not the Strata diagnostic",
      !`${missing.logs}${missing.startupError ?? ""}`.includes(DIAGNOSTIC),
    ),
  ].every(Boolean);
}

section("Linked workspace package (symlink outside node_modules), default and included");
{
  const linked = createApp("app-linked", "linked");
  let all = true;

  for (const scenario of SCENARIOS) {
    all =
      checkScenario(`linked ${scenario.name}`, scenario, await dev(linked, scenario.code), true) &&
      all;
  }

  for (const scenario of SCENARIOS) {
    const subpath = scenario.code.match(/"(@acme\/server-kit[^"]*)"/)?.[1] as string;

    all =
      checkStartup(
        `linked+include ${scenario.name}`,
        scenario,
        await startupIn(linked, scenario.code, { include: [subpath] }),
        true,
      ) && all;
  }

  verdict["dev linked package"] = all;
}

section("Cache regeneration: an assertion added to an already optimized installed package");
{
  const safe = SCENARIOS[1] as Scenario;
  const format = join(app, "node_modules/@acme/server-kit/format.js");
  const original = readFileSync(format, "utf8");

  await dev(app, safe.code, { cold: true });
  writeFileSync(format, `import "@strata-sc/server-components/server-only";\n${original}`);

  // The optimizer cache is keyed by the lockfile and the config, not by the
  // package's files, so the chunk is stale. The entry itself is read from its
  // file at the import, so it is refused anyway, on a warm cache too.
  const stale = await dev(app, safe.code, { cold: false });

  const forced = await dev(app, safe.code, { cold: false, optimizeDeps: { force: true } });
  const cold = await dev(app, safe.code, { cold: true });

  writeFileSync(format, original);

  const recovered = await dev(app, safe.code, { cold: true });

  // What the import cannot see: a module the entry reaches by an ordinary import
  // inside the stale chunk. This is the documented limit, measured so that a
  // change in Vite or in the firewall shows up here.
  const lazy = join(app, "node_modules/@acme/server-kit/internal/impl.js");
  const lazyOriginal = readFileSync(lazy, "utf8");
  const importing = `import { PRIVATE_IMPL } from "${KIT}/internal-user"; console.log(PRIVATE_IMPL);`;
  const manifest = join(app, "node_modules/@acme/server-kit/package.json");
  const manifestOriginal = readFileSync(manifest, "utf8");
  const user = join(app, "node_modules/@acme/server-kit/internal-user.js");

  writeFileSync(
    user,
    `import { PRIVATE_IMPL } from "./internal/impl.js";\nexport { PRIVATE_IMPL };\n`,
  );
  writeFileSync(
    manifest,
    manifestOriginal.replace(
      `"./format": "./format.js",`,
      `"./format": "./format.js",\n    "./internal-user": "./internal-user.js",`,
    ),
  );
  await dev(app, importing, { enabled: true, cold: true });
  writeFileSync(lazy, `import "@strata-sc/server-components/server-only";\n${lazyOriginal}`);

  const deepStale = await dev(app, importing, { cold: false });
  const deepCold = await dev(app, importing, { cold: true });

  writeFileSync(lazy, lazyOriginal);
  writeFileSync(manifest, manifestOriginal);
  rmSync(user);
  console.log(
    `  info  in-place edit behind an ordinary import, warm cache: ${deepStale.refused ? "refused" : "served the stale chunk (unsupported edit: restart with --force)"}`,
  );

  verdict["cache regeneration"] = [
    check("warm cache: the edited entry is refused at the import", stale.refused),
    check(
      "cold cache: an in-place edit behind an ordinary import is refused",
      deepCold.refused && deepCold.logs.includes(DIAGNOSTIC),
    ),
    check(
      "force: re-optimization refuses the new assertion",
      forced.refused && forced.logs.includes(DIAGNOSTIC),
    ),
    check("cold cache: refuses the new assertion", cold.refused && cold.logs.includes(DIAGNOSTIC)),
    check(
      "fixed: the package works again after a cold start",
      !recovered.refused && recovered.publicServed.includes("STRATA_FIXTURE_PUBLIC_FORMAT"),
    ),
    check(
      "no private marker in any step",
      [forced, cold, recovered].every((step) => step.privateServed.length === 0),
    ),
  ].every(Boolean);
}

section("Cache states of a forbidden entry");
{
  const barrel = SCENARIOS[6] as Scenario;
  const off = await dev(app, barrel.code, { enabled: false, cold: true });
  const warmFromUnprotected = await dev(app, barrel.code, { cold: false });
  const fresh = createApp("app-fresh", "packed");
  const freshInstall = await dev(fresh, barrel.code, { cold: false });

  verdict["cache states"] = [
    check("an unprotected run leaves a chunk with the markers", off.privateServed.length > 0),
    check(
      "warm cache written by an unprotected run: refused, nothing private served",
      warmFromUnprotected.refused && warmFromUnprotected.privateServed.length === 0,
    ),
    check(
      "fresh install, no cache yet: refused, nothing private served",
      freshInstall.refused && freshInstall.privateServed.length === 0,
    ),
  ].every(Boolean);
}

// ---------------------------------------------------------------------------
// Production

async function productionBuild(
  appDir: string,
  code: string,
  ssr: boolean,
  options: {
    readonly enabled?: boolean;
    readonly files?: Access["files"];
    /** Plugins ahead of Strata's: they answer `resolveId` before it is asked. */
    readonly before?: readonly object[];
  } = {},
): Promise<{ outDir: string; error?: string }> {
  const { enabled = true, files = {}, before = [] } = options;
  const strata = await installedPlugin(appDir);
  const outDir = join(appDir, ssr ? "dist-ssr" : "dist");

  rmSync(join(appDir, "src"), { recursive: true, force: true });
  mkdirSync(join(appDir, "src"));
  writeFileSync(join(appDir, "src/entry.ts"), code);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(appDir, "src", name), text);
  writeFileSync(join(appDir, "index.html"), `<script type="module" src="/src/entry.ts"></script>`);
  rmSync(outDir, { recursive: true, force: true });

  try {
    await viteBuild({
      root: appDir,
      configFile: false,
      logLevel: "silent",
      plugins: [
        ...before,
        strata({ root: appDir, sourceDir: "src", generatedDir: "src/.strata", enabled }),
      ],
      ...(ssr ? { ssr: { noExternal: true } } : {}),
      build: {
        outDir,
        sourcemap: true,
        emptyOutDir: true,
        ...(ssr ? { ssr: join(appDir, "src/entry.ts") } : {}),
      },
    } as InlineConfig);

    return { outDir };
  } catch (error) {
    return { outDir, error: String((error as Error).message) };
  }
}

/**
 * The private markers in `dir`, as plain text or inside a base64 data URL:
 * below `assetsInlineLimit`, `?url` and `new URL()` write a file into a chunk
 * encoded, where a substring scan would call it clean.
 */
function exposedIn(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return listFiles(dir).flatMap((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    const decoded = [...text.matchAll(/;base64,([A-Za-z0-9+/=]+)/g)]
      .map(([, data]) => Buffer.from(data as string, "base64").toString("utf8"))
      .join("\n");

    return PRIVATE.filter((marker) => text.includes(marker) || decoded.includes(marker)).map(
      (marker) => `${marker}@${file}`,
    );
  });
}

section("Production builds (vite build), browser graph with source maps");
{
  let all = true;

  for (const scenario of [...SCENARIOS, ...GRAPH_SCENARIOS]) {
    const result = await productionBuild(app, scenario.code, false);
    const leaked = exposedIn(result.outDir);

    if (scenario.expect === "safe") {
      all =
        check(
          `${scenario.name}: build passes`,
          result.error === undefined,
          result.error?.slice(0, 200),
        ) && all;
      all =
        check(
          `${scenario.name}: public marker in the browser output`,
          scenario.marker !== undefined &&
            findFilesContaining(result.outDir, scenario.marker).length > 0,
        ) && all;
    } else {
      all =
        check(
          `${scenario.name}: build refused with the Strata diagnostic`,
          result.error?.includes(DIAGNOSTIC) === true,
          result.error?.slice(0, 200),
        ) && all;
      all =
        check(
          `${scenario.name}: names the server-only module`,
          (scenario.names ?? []).every((name) => result.error?.includes(name)),
        ) && all;
    }

    all =
      check(
        `${scenario.name}: no private marker in the browser output or source maps`,
        leaked.length === 0,
        leaked.join(","),
      ) && all;
  }

  verdict["production browser graph"] = all;
}

section("Production: access that never parses a module, and worker graphs");
{
  const results: boolean[] = [];

  for (const scenario of ACCESS_SCENARIOS) {
    const options = scenario.files ? { files: scenario.files } : {};
    const open = await productionBuild(app, scenario.code, false, { ...options, enabled: false });
    const openExposure = exposedIn(open.outDir);
    const closed = await productionBuild(app, scenario.code, false, options);
    const leaked = exposedIn(closed.outDir);
    const message = messageOf(closed.error ?? "");

    results.push(
      check(
        `${scenario.name}: firewall off, the build ships the markers (control)`,
        open.error === undefined && openExposure.length > 0,
        open.error?.slice(0, 200) ?? openExposure.join(","),
      ),
      check(
        `${scenario.name}: refused with the Strata diagnostic`,
        closed.error?.includes(DIAGNOSTIC) === true,
        closed.error?.slice(0, 200),
      ),
      check(
        `${scenario.name}: nothing private in the output`,
        leaked.length === 0,
        leaked.join(","),
      ),
      check(
        `${scenario.name}: the diagnostic has a reason and no machine path or private value`,
        message.includes("Reason: ") &&
          !message.includes(work) &&
          !message.includes(repoRoot) &&
          PRIVATE.every((marker) => !message.includes(marker)),
        message.slice(0, 300),
      ),
    );
  }

  for (const scenario of LEGAL_ACCESS) {
    const result = await productionBuild(
      app,
      scenario.code,
      false,
      scenario.files ? { files: scenario.files } : {},
    );

    results.push(
      check(`${scenario.name}: builds`, result.error === undefined, result.error?.slice(0, 300)),
      check(`${scenario.name}: nothing private`, exposedIn(result.outDir).length === 0),
    );
  }

  // A plugin ahead of Strata's answers the import, so `resolveId` is never asked and only the
  // `load` guard sees the query. Without that guard this is a successful build with the source.
  const earlier = {
    name: "fixture:resolves-first",
    enforce: "pre",
    resolveId: (source: string) =>
      source === "fixture:secret"
        ? join(app, "node_modules/@acme/server-kit/secret.js") + "?raw"
        : null,
  };
  const aliased = `import s from "fixture:secret"; console.log(s);`;
  const unguarded = await productionBuild(app, aliased, false, {
    before: [earlier],
    enabled: false,
  });
  const unguardedExposure = exposedIn(unguarded.outDir);
  const guarded = await productionBuild(app, aliased, false, { before: [earlier] });

  results.push(
    check(
      "query id resolved by an earlier plugin: firewall off, the build ships the markers (control)",
      unguarded.error === undefined && unguardedExposure.length > 0,
      unguarded.error?.slice(0, 200),
    ),
    check(
      "query id resolved by an earlier plugin: refused at load with the Strata diagnostic",
      guarded.error?.includes(DIAGNOSTIC) === true,
      guarded.error?.slice(0, 200),
    ),
    check(
      "query id resolved by an earlier plugin: nothing private in the output",
      exposedIn(guarded.outDir).length === 0,
    ),
  );

  const shown = await productionBuild(
    app,
    `console.log(${JSON.stringify(`import "@strata-sc/server-components/server-only";`)});`,
    false,
  );

  results.push(
    check(
      "a page that displays the assertion as text is not refused",
      shown.error === undefined,
      shown.error?.slice(0, 300),
    ),
  );
  verdict["production access without a parse, and worker graphs"] = results.every(Boolean);
}

section("Diagnostic: what a refused package import says");
{
  const result = await productionBuild(app, SCENARIOS[7]?.code ?? "", false);
  const message = messageOf(result.error ?? "");

  console.log(message);
  verdict["diagnostic names importer, entry, chain, assertion and fix"] = [
    check("names the client importer", message.includes("Imported from: src/entry.ts")),
    check("names the package entry", message.includes(`Package entry: ${KIT}/chain`)),
    check(
      "prints the chain with package-relative paths",
      message.includes(
        `${INSTALLED}/chain.js → ${INSTALLED}/barrel.js → ${INSTALLED}/secret.js, which declares`,
      ),
    ),
    check(
      "names the assertion",
      message.includes(`import "@strata-sc/server-components/server-only";`),
    ),
    check("gives the supported fix", message.includes("package subpath that does not reach")),
    check("says the package itself is not refused", message.includes("not the package")),
  ].every(Boolean);
}

section("Production server graph (positive control: the same markers ARE in the server bundle)");
{
  const result = await productionBuild(app, SCENARIOS[5]?.code ?? "", true);

  verdict["production server graph keeps the implementation"] = [
    check("SSR build passes", result.error === undefined, result.error?.slice(0, 200)),
    check(
      "server-only marker in the server bundle",
      findFilesContaining(result.outDir, "STRATA_FIXTURE_SERVER_ONLY").length > 0,
    ),
    check(
      "private implementation marker in the server bundle",
      findFilesContaining(result.outDir, "STRATA_FIXTURE_PRIVATE_IMPL").length > 0,
    ),
  ].every(Boolean);
}

section("Cost of the optimizer firewall (single runs; see the report for method)");
{
  const sample = SCENARIOS[1] as Scenario;
  const off = await dev(app, sample.code, { enabled: false, cold: true });
  const on = await dev(app, sample.code, { enabled: true, cold: true });
  const warmOff = await dev(app, sample.code, { enabled: false, cold: false });
  const warmOn = await dev(app, sample.code, { enabled: true, cold: false });
  const ms = (value: number): string => `${Math.round(value)} ms`;

  console.log(
    `  info  safe entry, cold start+first load: firewall off ${ms(off.startupMs + off.crawlMs)}, on ${ms(on.startupMs + on.crawlMs)}`,
  );
  console.log(
    `  info  safe entry, warm start+first load: firewall off ${ms(warmOff.startupMs + warmOff.crawlMs)}, on ${ms(warmOn.startupMs + warmOn.crawlMs)}`,
  );
  verdict["safe entry unaffected by the firewall"] = check(
    "safe entry allowed with the firewall on, cold and warm",
    !on.refused && !warmOn.refused,
  );
}

section("Verdict");

for (const [name, ok] of Object.entries(verdict)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);

rmSync(work, { recursive: true, force: true });
finish(TITLE);
