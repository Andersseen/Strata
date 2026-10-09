import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { httpGet } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";
import { run } from "../consumer/lib/exec.ts";
import { publishedVersion } from "../release/lib/published.ts";
import { isExactVersion, latestTagVerdict } from "../release/lib/registry-version.ts";

import { observeBrowser } from "./lib/browser.ts";
import {
  EXPECTED_EVIDENCE,
  MARKERS,
  SERVER_MARKERS,
  SERVER_MESSAGE_A,
} from "./lib/consumer-fixture.ts";
import { check, finish, repoRoot, section } from "./lib/harness.ts";
import {
  installedManifest,
  isSymlinkAnywhere,
  isUnder,
  isolatedEnv,
  resolveFromConsumer,
  restoreDir,
  sleep,
  snapshotDir,
  startNodeServer,
} from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";

/**
 * `pnpm test:server-component-registry-consumer`: the post-publish gate. It
 * installs the EXACT version of @strata-sc/server-components that a release
 * just published, from https://registry.npmjs.org, into a fresh OS temp app and
 * proves the registry artifact works. Run by .github/workflows/release.yml only
 * when a release published this package. It never publishes, unpublishes or
 * moves a dist-tag.
 *
 *   STRATA_SC_REGISTRY_VERSION     exact version (e.g. from a manual re-check), or
 *   STRATA_PUBLISHED_PACKAGES      changesets/action's `publishedPackages` JSON
 *
 * This is the focused registry gate (resolve, production build, graph split,
 * SSR, protocol v1, hydration, one interaction, server-only firewall). The full
 * qualification — declarations under TypeScript 5.9/6, dev server, Cloudflare/
 * workerd — stays in `pnpm test:server-component-package-consumer`, which
 * qualifies the identical tarball before it is published.
 */

const TITLE = "server-component registry consumer";
const PACKAGE = "@strata-sc/server-components";
const REGISTRY = "https://registry.npmjs.org";
// Bounded: at most 24 × 10 s. The env overrides exist to exercise the failure path quickly.
const PROPAGATION_ATTEMPTS = Number(process.env["STRATA_SC_REGISTRY_ATTEMPTS"] ?? 24);
const PROPAGATION_INTERVAL_MS = Number(process.env["STRATA_SC_REGISTRY_INTERVAL_MS"] ?? 10_000);

const sanitize = (text: string): string => stripVTControlCharacters(text);

const version = process.env["STRATA_SC_REGISTRY_VERSION"]?.trim()
  ? process.env["STRATA_SC_REGISTRY_VERSION"].trim()
  : publishedVersion(process.env["STRATA_PUBLISHED_PACKAGES"], PACKAGE);

if (!version || !isExactVersion(version)) {
  console.error(
    `${TITLE}: set STRATA_SC_REGISTRY_VERSION to an exact version, or STRATA_PUBLISHED_PACKAGES to a changesets publishedPackages list that contains ${PACKAGE}.`,
  );
  process.exit(2);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-server-component-registry-"));
const consumerDir = join(tmpRoot, "consumer");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);
const fixtureTemplate = join(repoRoot, "tests", "server-component-package-consumer", "fixture");
const servers: RunningServer[] = [];

const npm = (args: readonly string[], cwd = tmpRoot) =>
  run("npm", [...args, "--registry", REGISTRY], { cwd, env });

const vite = (args: readonly string[]) =>
  run(process.execPath, [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), ...args], {
    cwd: consumerDir,
    env,
  });

const NOT_SOURCE = (path: string): boolean =>
  /^(node_modules|dist|\.nitro|\.output|\.angular|package-lock\.json)(\/|$)/.test(path) ||
  path.startsWith("src/generated/");

const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);
const graphFiles = (dirs: readonly string[]): string[] =>
  dirs.flatMap((dir) =>
    existsSync(dist(dir)) ? listFiles(dist(dir)).map((file) => `${dir}/${file}`) : [],
  );
const filesWith = (files: readonly string[], needle: string): string[] =>
  files.filter((file) => readFileSync(dist(file), "utf8").includes(needle));

function cleanOutput(): void {
  for (const dir of ["dist", "src/generated", ".nitro", ".angular"]) {
    rmSync(join(consumerDir, dir), { recursive: true, force: true });
  }
}

try {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");

  // ------------------------------------------------------------------------
  section(`Registry visibility of ${PACKAGE}@${version} (bounded polling)`);

  let visible = false;

  for (let attempt = 1; attempt <= PROPAGATION_ATTEMPTS && !visible; attempt++) {
    const view = npm(["view", `${PACKAGE}@${version}`, "version"]);

    visible = view.status === 0 && view.stdout.trim() === version;
    if (!visible) {
      console.log(`attempt ${attempt}/${PROPAGATION_ATTEMPTS}: not visible yet`);
      if (attempt < PROPAGATION_ATTEMPTS) await sleep(PROPAGATION_INTERVAL_MS);
    }
  }

  if (!check(`${PACKAGE}@${version} is visible on ${REGISTRY}`, visible))
    throw new Error("not visible");

  const dist_ = JSON.parse(
    npm(["view", `${PACKAGE}@${version}`, "dist", "--json"]).stdout || "{}",
  ) as {
    integrity?: string;
    tarball?: string;
  };

  console.log(`dist.integrity: ${dist_.integrity ?? "(missing)"}`);
  console.log(`dist.tarball:   ${dist_.tarball ?? "(missing)"}`);
  check("dist.integrity is present (sha512)", /^sha512-/.test(dist_.integrity ?? ""));
  check(
    "dist.tarball is on the npm registry",
    (dist_.tarball ?? "").startsWith(`${REGISTRY}/${PACKAGE}/-/`),
  );

  // ------------------------------------------------------------------------
  section("dist-tags");

  const tags = JSON.parse(npm(["view", PACKAGE, "dist-tags", "--json"]).stdout || "{}") as Record<
    string,
    string
  >;

  console.log(`dist-tags: ${JSON.stringify(tags)}`);
  check(`next → ${version}`, tags["next"] === version, JSON.stringify(tags));
  // Read-only: this gate never edits tags; it only confirms the release did not move latest.
  // npm itself assigns `latest` to a package's first-ever version, so that single case is accepted.
  const allVersions = JSON.parse(npm(["view", PACKAGE, "versions", "--json"]).stdout || "[]") as
    string | string[];
  const latest = latestTagVerdict(tags, [allVersions].flat(), version);

  console.log(`latest: ${latest.reason}`);
  check("latest was not moved by this release", latest.ok, JSON.stringify(tags));

  // ------------------------------------------------------------------------
  section("External install from the registry (fresh temp app, plain `npm install`)");

  check(
    "the consumer lives outside the repository",
    !realpathSync(tmpRoot).startsWith(realpathSync(repoRoot)),
  );
  cpSync(fixtureTemplate, consumerDir, { recursive: true });

  const manifestPath = join(consumerDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
  };

  manifest.dependencies[PACKAGE] = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const install = npm(["install", "--no-audit", "--no-fund", "--loglevel=error"], consumerDir);

  if (!check("npm install exits 0", install.status === 0, sanitize(install.stderr).slice(-1500)))
    throw new Error("install failed");

  const installed = join(consumerDir, "node_modules", PACKAGE);
  const installedVersion = installedManifest(consumerDir, PACKAGE)?.version;

  check(
    `installed package.json version === ${version}`,
    installedVersion === version,
    `${installedVersion}`,
  );
  check(
    "a real directory under consumer/node_modules, not a symlink",
    isUnder(realpathSync(installed), join(realpathSync(consumerDir), "node_modules")) &&
      !isSymlinkAnywhere(installed) &&
      lstatSync(installed).isDirectory(),
  );

  const resolved = resolveFromConsumer(
    consumerDir,
    [PACKAGE, `${PACKAGE}/vite`, `${PACKAGE}/server-only`],
    env,
  );

  for (const [specifier, url] of Object.entries(resolved))
    console.log(`resolve ${specifier} → ${url}`);
  check(
    "`.`, `/vite` and `/server-only` resolve under consumer/node_modules, never the repository",
    Object.values(resolved).every(
      (url) =>
        isUnder(url, join(consumerDir, "node_modules")) &&
        !realpathSync(new URL(url)).startsWith(realpathSync(repoRoot) + "/"),
    ),
  );

  // Provenance and signatures: npm's documented `npm audit signatures`. Recorded, and only
  // a verification failure reported by npm itself fails the gate (not a missing capability).
  const signatures = npm(["audit", "signatures"], consumerDir);

  console.log(
    `npm audit signatures: exit ${signatures.status}\n${sanitize(signatures.stdout).trim()}`,
  );
  check(
    "npm audit signatures reports no invalid signature or attestation",
    !/invalid (registry )?signature|invalid attestation/i.test(
      `${signatures.stdout}${signatures.stderr}`,
    ),
  );

  // ------------------------------------------------------------------------
  section("Production build of the registry package (Node)");

  const pristine = snapshotDir(consumerDir, NOT_SOURCE);

  cleanOutput();
  const built = vite(["build"]);

  if (
    !check(
      "consumer `vite build` exits 0",
      built.status === 0,
      sanitize(built.stderr || built.stdout).slice(-2000),
    )
  )
    throw new Error("build failed");

  const browser = graphFiles(["client", "analog/public"]);
  const server = graphFiles(["analog/server", "ssr"]);

  for (const marker of SERVER_MARKERS) {
    check(`${marker}: absent from every browser file`, filesWith(browser, marker).length === 0);
    check(
      `${marker}: present in the Node server output (positive control)`,
      filesWith(server, marker).length > 0,
    );
  }
  check(
    `${MARKERS.client}: present in the browser graph`,
    filesWith(
      browser.filter((f) => f.endsWith(".js")),
      MARKERS.client,
    ).length > 0,
  );

  const node = await startNodeServer(consumerDir, env);

  servers.push(node);

  const response = await httpGet(`${node.baseUrl}/product`);
  const html = response.body;

  check(
    "GET /product: 200 text/html",
    response.status === 200 && !!response.contentType?.includes("text/html"),
  );
  check(
    "SSR HTML has the server-rendered content and server-computed evidence",
    html.includes("<h1>Product 42</h1>") &&
      html.includes(`>${SERVER_MESSAGE_A}</p>`) &&
      html.includes(`data-evidence="${EXPECTED_EVIDENCE}"`),
  );
  check(
    'boundary protocol v1 (data-strata-protocol="1") with an ngh annotation',
    /<add-to-cart data-strata-client="add-to-cart" data-strata-protocol="1"[^>]* ngh="\d+">/.test(
      html,
    ),
    html.match(/<add-to-cart[^>]*>/)?.[0] ?? "no boundary",
  );
  check(
    "SSR HTML exposes no server marker",
    SERVER_MARKERS.every((marker) => !html.includes(marker)),
  );

  const observation = await observeBrowser(`${node.baseUrl}/product`);

  check("the client island hydrates", observation.hydratedWithinTimeout);
  check(
    "SSR DOM nodes are reused; no leftover ngh annotations",
    Object.values(observation.sameNodes).every(Boolean) &&
      observation.remainingHydrationAnnotations === 0,
    JSON.stringify(observation.sameNodes),
  );
  check(
    "one click: Count: 0 → Count: 1",
    observation.countAfterHydration === "Count: 0" && observation.countAfterClick === "Count: 1",
    `${observation.countAfterHydration} → ${observation.countAfterClick}`,
  );
  check(
    "no console error or warning",
    observation.errors.length === 0,
    observation.errors.join(" | "),
  );
  check(
    "no loaded script carries a server marker",
    observation.scripts.every((s) => SERVER_MARKERS.every((m) => !s.body.includes(m))),
  );

  await node.stop();
  servers.length = 0;

  // ------------------------------------------------------------------------
  section("server-only firewall from the registry plugin");

  const addToCart = join(consumerDir, "src", "app", "product", "add-to-cart.component.ts");

  restoreDir(consumerDir, pristine, NOT_SOURCE);
  writeFileSync(
    addToCart,
    `import { ProductRepository } from "./product.repository";\n${readFileSync(
      addToCart,
      "utf8",
    ).replace(
      "protected readonly marker = CLIENT_MARKER;",
      "protected readonly marker = CLIENT_MARKER;\n  protected readonly leak = ProductRepository.name;",
    )}`,
  );
  cleanOutput();

  const failing = vite(["build"]);
  const output = sanitize(`${failing.stdout}\n${failing.stderr}`);

  check(
    "a direct server-only import in a client module fails the production build",
    failing.status !== 0,
  );
  check(
    "the diagnostic is the plugin's ([strata] Server-only module entered the browser graph) and prints no marker",
    /\[strata\] Server-only module entered the browser graph: src\/app\/product\/product\.repository\.ts/.test(
      output,
    ) && SERVER_MARKERS.every((marker) => !output.includes(marker)),
    output.slice(-600),
  );
} catch (error) {
  check(
    "the registry qualification ran to completion",
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  for (const server of servers) await server.stop().catch(() => undefined);

  if (process.env["STRATA_KEEP_CONSUMER"] === "1") {
    console.log(`kept: ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

finish(`${TITLE} (${PACKAGE}@${version})`);
