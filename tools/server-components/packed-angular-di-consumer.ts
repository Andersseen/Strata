import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../consumer/lib/exec.ts";

import { installFullStackConsumer } from "./lib/full-stack-install.ts";
import { repoRoot, check, finish, section } from "./lib/harness.ts";
import { isolatedEnv, startNodeServer } from "./lib/package-consumer.ts";

const fixture = join(repoRoot, "tests", "analog-packed-di-consumer");
const tmpRoot = mkdtempSync(join(tmpdir(), "strata-packed-angular-di-"));
const consumer = join(tmpRoot, "consumer");
const emptyUserConfig = join(tmpRoot, "empty.npmrc");
const emptyGlobalConfig = join(tmpRoot, "empty-global.npmrc");
writeFileSync(emptyUserConfig, "");
writeFileSync(emptyGlobalConfig, "");
const env = isolatedEnv(emptyUserConfig, emptyGlobalConfig);
const no = (label: string, result: { status: number; stdout: string; stderr: string }) =>
  check(label, result.status === 0, `${result.stdout}\n${result.stderr}`.slice(-6_000));

let server: Awaited<ReturnType<typeof startNodeServer>> | undefined;
try {
  section("Install the actual Strata tarballs into an isolated Analog consumer");
  const installed = installFullStackConsumer({
    tmpRoot,
    consumerDir: consumer,
    env,
    time: (_label, work) => work(),
  });
  check("packed core, analog and server-components install cleanly", installed.ok);

  section("Add the Node-only consumer-owned Angular integration");
  cpSync(join(fixture, "src", "server"), join(consumer, "src", "server"), { recursive: true });
  const viteConfig = join(consumer, "vite.config.ts");
  const config = readFileSync(viteConfig, "utf8");
  writeFileSync(
    viteConfig,
    config.replace("analog()", 'analog({ nitro: { moduleSideEffects: ["@angular/compiler"] } })'),
  );
  check(
    "the consumer fixture remains outside the workspace and installed Strata packages are real directories",
    !consumer.startsWith(repoRoot) &&
      !existsSync(join(consumer, "node_modules", "@strata-sc", "analog", "src")),
  );

  const typeConfig = join(consumer, "tsconfig.packed-di.json");
  writeFileSync(
    typeConfig,
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          types: ["node"],
        },
        files: [
          "src/server/strata/providers.ts",
          "src/server/strata/controller.ts",
          "src/server/strata/public-types.ts",
        ],
      },
      null,
      2,
    )}\n`,
  );
  const typeArgs = ["--project", typeConfig];
  const tsc = join(consumer, "node_modules", "typescript", "bin", "tsc");
  const typed = run(process.execPath, [tsc, ...typeArgs], { cwd: consumer, env });
  no(
    "consumer Angular services, factory, guard and interceptor declarations typecheck strictly",
    typed,
  );

  section("Build and run the consumer's production Nitro Node server");
  const vite = join(consumer, "node_modules", "vite", "bin", "vite.js");
  const built = run(process.execPath, [vite, "build"], { cwd: consumer, env });
  no("consumer Vite production build succeeds", built);
  if (built.status !== 0)
    throw new Error("Consumer production build failed; see the compiler output above.");
  server = await startNodeServer(consumer, env);

  const request = (id: string, token: string, delay = 0) =>
    fetch(`${server!.baseUrl}/api/packed-angular-di/${id}?delay=${delay}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const denied = await request("private", "");
  const deniedBody = await denied.text();
  check("missing credentials are denied before controller construction", denied.status === 401);
  check(
    "denial response is no-store and does not expose fixture secrets",
    denied.headers.get("cache-control") === "no-store" &&
      !/packed-alpha|packed-beta/.test(deniedBody),
  );

  const invalid = await request("private", "not-a-credential");
  const forbidden = await request("beta-only", "packed-alpha");
  check(
    "invalid credentials return 401 and a cross-principal resource returns 403, both no-store",
    invalid.status === 401 &&
      forbidden.status === 403 &&
      invalid.headers.get("cache-control") === "no-store" &&
      forbidden.headers.get("cache-control") === "no-store",
  );
  const nativeRoute = await fetch(`${server.baseUrl}/api/native`);
  check(
    "the consumer's native Nitro route coexists with Strata controller routes",
    nativeRoute.status === 200 && (await nativeRoute.text()).includes('"source":"analog"'),
  );

  const responses = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      request(`item-${index}`, index % 2 ? "packed-beta" : "packed-alpha", 25),
    ),
  );
  const values = await Promise.all(
    responses.map(async (response) => ({
      status: response.status,
      value: (await response.json()) as Record<string, unknown>,
    })),
  );
  check(
    "24 overlapping HTTP requests complete successfully",
    values.every(({ status }) => status === 200),
  );
  check(
    "consumer principals stay associated with their own requests",
    values.every(({ value }, index) => value["principal"] === (index % 2 ? "beta" : "alpha")),
  );
  check(
    "request providers are distinct while the application service is reused",
    new Set(values.map(({ value }) => value["identity"])).size === 24 &&
      values.every(({ value }) => value["catalogInstance"] === 1),
  );
  check(
    "captured Angular services remain usable after await and controllers are released after response",
    values.every(
      ({ value }) =>
        value["requestIdentityStable"] === true && value["destroyedBeforeResponse"] === false,
    ),
  );
  check(
    "every API response contains no private credential",
    values.every(
      ({ value }) =>
        !JSON.stringify(value).includes("packed-alpha") &&
        !JSON.stringify(value).includes("packed-beta"),
    ),
  );

  const statsResponse = await fetch(`${server.baseUrl}/api/packed-di-stats`);
  const stats = (await statsResponse.json()) as {
    injectorsCreated: number;
    injectorsDestroyed: number;
    guardCleanups: number;
    interceptorCalls: number;
    handlerCalls: number;
    live: number;
  };
  check(
    "authorized calls each receive exactly one injector and cleanup",
    stats.injectorsCreated === 24 &&
      stats.injectorsDestroyed === 24 &&
      stats.identitiesDestroyed === 24 &&
      stats.controllersDestroyed === 24 &&
      stats.guardCleanups === 27 &&
      stats.interceptorCalls === 24 &&
      stats.handlerCalls === 24 &&
      stats.live === 0,
    `${JSON.stringify(stats)}; response=${statsResponse.status}; log=${server.output().slice(-1_200)}`,
  );

  section("Streamed responses keep the request-scoped Angular injector open until the body ends");
  const before = (await (await fetch(`${server.baseUrl}/api/packed-di-stats`)).json()) as {
    injectorsCreated: number;
    injectorsDestroyed: number;
    identitiesDestroyed: number;
    controllersDestroyed: number;
    live: number;
  };
  const streamed = await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const response = await fetch(
        `${server!.baseUrl}/api/packed-angular-di/stream-${index}/stream`,
        {
          headers: { authorization: `Bearer ${index % 2 ? "packed-beta" : "packed-alpha"}` },
        },
      );
      const rows = (await response.text())
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              row: number;
              product: { id: string };
              principal: string;
              destroyed: boolean;
            },
        );
      return { status: response.status, rows, index };
    }),
  );
  check(
    "six overlapping streamed responses each read their own request injector for every row",
    streamed.every(
      ({ status, rows, index }) =>
        status === 200 &&
        rows.length === 3 &&
        rows.every(
          (row, position) =>
            row.row === position + 1 &&
            row.product.id === `stream-${index}` &&
            row.principal === (index % 2 ? "beta" : "alpha") &&
            row.destroyed === false,
        ),
    ),
    JSON.stringify(streamed.slice(0, 2)),
  );
  const after = (await (
    await fetch(`${server.baseUrl}/api/packed-di-stats`)
  ).json()) as typeof before;
  check(
    "each streamed response's injector, request identity and controller are destroyed exactly once, after the body",
    after.injectorsCreated === before.injectorsCreated + 6 &&
      after.injectorsDestroyed === before.injectorsDestroyed + 6 &&
      after.identitiesDestroyed === before.identitiesDestroyed + 6 &&
      after.controllersDestroyed === before.controllersDestroyed + 6 &&
      after.live === 0,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
  const deniedStream = await fetch(`${server.baseUrl}/api/packed-angular-di/stream-denied/stream`);
  await deniedStream.text();
  const afterDenied = (await (
    await fetch(`${server.baseUrl}/api/packed-di-stats`)
  ).json()) as typeof before;
  check(
    "a denied streamed request creates no injector",
    deniedStream.status === 401 && afterDenied.injectorsCreated === after.injectorsCreated,
  );

  section("Repeat the strict consumer declaration check with TypeScript 5.9.2");
  const ts59Dir = join(tmpRoot, "typescript-59");
  mkdirSync(ts59Dir, { recursive: true });
  const ts59Install = run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      "--ignore-scripts",
      "typescript@5.9.2",
    ],
    { cwd: ts59Dir, env },
  );
  no("isolated TypeScript 5.9.2 compiler installs", ts59Install);
  const tsc59 = join(ts59Dir, "node_modules", "typescript", "bin", "tsc");
  const typed59 = run(process.execPath, [tsc59, ...typeArgs], { cwd: consumer, env });
  no("consumer Angular services and Strata API types pass strict TypeScript 5.9.2", typed59);
} finally {
  if (server) {
    await server.stop();
    const closeEvents = server.output().match(/packed angular DI root closed/g) ?? [];
    check(
      "Nitro close hook destroys the consumer-owned Angular root and platform once",
      closeEvents.length === 1,
    );
  }
  if (process.env["STRATA_KEEP_CONSUMER"] === "1") console.log(`kept consumer: ${consumer}`);
  else rmSync(tmpRoot, { recursive: true, force: true });
}

finish("packed Angular DI Node consumer qualification");
