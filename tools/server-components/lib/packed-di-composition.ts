import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, relative } from "node:path";

import { check, section } from "./harness.ts";
import { until } from "./package-consumer.ts";

/**
 * The composed SPEC-003 matrix through INSTALLED packages and consumer-owned code
 * (tests/analog-packed-di-consumer/src/server/strata/composition.*). The internal fixture
 * (`pnpm test:analog`) already proves this composition against workspace sources; the value here
 * is the same behaviour through packed `@strata-sc/core` and `@strata-sc/analog` tarballs, the
 * consumer's own Angular application injector and a real Nitro Node production server.
 *
 * Every lifecycle step is recorded by consumer code and closed by `onRequestSettled`, keyed by
 * Strata's `requestCorrelation` id, so the harness reads the exact order Strata actually ran:
 * guards, interceptor entry, factory, construction, handler, interceptor unwind, cleanup (LIFO)
 * and the single settlement observation. No sleep synchronises anything: overlap is proven by a
 * rendezvous every participating handler must reach.
 */

const CANARIES = [
  "PACKED_PRIVATE_COMPOSITION_CANARY",
  "STRATA_PACKED_DI_COMPOSITION_SERVER_MARKER",
  "packed-alpha",
  "packed-beta",
];

interface Trace {
  readonly outcome: string;
  readonly status: number | null;
  readonly phase: string;
  readonly cleanup: string;
  readonly steps: readonly string[];
}

type Stats = Record<string, number> & { readonly completed: Record<string, Trace> };

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly json: Record<string, unknown> | undefined;
  readonly headers: Headers;
}

const ENTRY = ["guard", "outer:before", "inner:before"];
const CLEANUP_WITH_INJECTOR = [
  "cleanup:injector",
  "cleanup:inner",
  "cleanup:outer",
  "cleanup:guard",
];
const CLEANUP_WITHOUT_INJECTOR = ["cleanup:inner", "cleanup:outer", "cleanup:guard"];
const UNWIND_ERROR = ["inner:error", "outer:error"];

/** What a completed invocation looks like, step by step, for each path the contract defines. */
export const EXPECTED_TRACES = {
  success: [
    ...ENTRY,
    "factory",
    "construct",
    "handler",
    "inner:after",
    "outer:after",
    ...CLEANUP_WITH_INJECTOR,
    "observed",
  ],
  denied: ["guard", "cleanup:guard", "observed"],
  handlerError: [
    ...ENTRY,
    "factory",
    "construct",
    "handler",
    ...UNWIND_ERROR,
    ...CLEANUP_WITH_INJECTOR,
    "observed",
  ],
  factoryError: [...ENTRY, "factory", ...UNWIND_ERROR, ...CLEANUP_WITHOUT_INJECTOR, "observed"],
  providerError: [...ENTRY, "factory", ...UNWIND_ERROR, ...CLEANUP_WITH_INJECTOR, "observed"],
  constructorError: [
    ...ENTRY,
    "factory",
    "construct",
    ...UNWIND_ERROR,
    ...CLEANUP_WITH_INJECTOR,
    "observed",
  ],
  interceptorBefore: [...ENTRY, ...UNWIND_ERROR, ...CLEANUP_WITHOUT_INJECTOR, "observed"],
  interceptorAfter: [
    ...ENTRY,
    "factory",
    "construct",
    "handler",
    "inner:after",
    ...UNWIND_ERROR,
    ...CLEANUP_WITH_INJECTOR,
    "observed",
  ],
} as const;

const same = (actual: readonly string[] | undefined, expected: readonly string[]): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

const leaks = (reply: Reply): boolean => CANARIES.some((canary) => reply.body.includes(canary));

export async function compositionMatrix(base: string): Promise<boolean> {
  const results: boolean[] = [];
  let sequence = 0;

  const send = async (
    id: string,
    query: Record<string, string>,
    init: {
      token?: "packed-alpha" | "packed-beta" | "invalid";
      method?: string;
      body?: string;
      type?: string;
    } = {},
  ): Promise<Reply> => {
    const response = await fetch(
      `${base}/api/packed-composition/products/${id}?${new URLSearchParams(query).toString()}`,
      {
        method: init.method ?? "GET",
        headers: {
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init.type ? { "content-type": init.type } : {}),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      },
    );
    const body = await response.text();
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { status: response.status, body, json, headers: response.headers };
  };
  const stats = async (): Promise<Stats> =>
    (await (await fetch(`${base}/api/packed-composition-stats`)).json()) as Stats;
  const label = (name: string): string => `${name}-${++sequence}`;

  /** Runs requests, then compares counters and the labelled traces Strata settled. */
  const scenario = async (
    name: string,
    run: () => Promise<{ replies: Reply[]; labels: string[] }>,
    assert: (
      replies: Reply[],
      delta: Record<string, number>,
      traces: (Trace | undefined)[],
      after: Stats,
    ) => boolean,
  ): Promise<void> => {
    const before = await stats();
    const { replies, labels } = await run();
    const after = await stats();
    const delta = Object.fromEntries(
      Object.entries(after)
        .filter(([, value]) => typeof value === "number")
        .map(([key, value]) => [key, (value as number) - (before[key] ?? 0)]),
    );
    const traces = labels.map((name) => after.completed[name]);
    results.push(
      check(
        name,
        assert(replies, delta, traces, after) &&
          delta["duplicateCleanups"] === 0 &&
          delta["observationsWithoutTrace"] === 0 &&
          after["live"] === 0,
        JSON.stringify({
          statuses: replies.map((reply) => reply.status),
          bodies: replies.map((reply) => reply.body.slice(0, 160)),
          delta,
          traces,
        }).slice(0, 3_000),
      ),
    );
  };

  section(
    "Packed DI composition: two interceptors, validation, guards and the Angular request injector",
  );

  await scenario(
    "authorized GET and POST run guard → outer → inner → factory → handler → unwind → LIFO cleanup → one observation",
    async () => {
      const labels = [label("get"), label("post")];
      const replies = await Promise.all([
        send("101", { tag: "spring", trace: labels[0]! }, { token: "packed-alpha" }),
        send(
          "102",
          { trace: labels[1]! },
          {
            token: "packed-beta",
            method: "POST",
            body: JSON.stringify({ count: "7" }),
            type: "application/json",
          },
        ),
      ]);
      return { replies, labels };
    },
    ([get, post], delta, [getTrace, postTrace]) =>
      get?.status === 200 &&
      get.json?.["principal"] === "alpha" &&
      get.json?.["tag"] === "SPRING" &&
      (get.json?.["product"] as { id?: number } | undefined)?.id === 101 &&
      get.json?.["transformedBy"] === "outer" &&
      same(get.json?.["order"] as string[] | undefined, EXPECTED_TRACES.success.slice(0, 8)) &&
      get.json?.["capturedAfterAwait"] === true &&
      get.json?.["destroyedBeforeResponse"] === false &&
      get.json?.["audit"] === "request-audit" &&
      get.json?.["catalogInstance"] === 1 &&
      post?.status === 200 &&
      post.json?.["principal"] === "beta" &&
      post.json?.["count"] === 7 &&
      post.json?.["catalogInstance"] === 1 &&
      get.json?.["identity"] !== post.json?.["identity"] &&
      same(getTrace?.steps, EXPECTED_TRACES.success) &&
      same(postTrace?.steps, EXPECTED_TRACES.success) &&
      getTrace?.outcome === "completed" &&
      getTrace.cleanup === "completed" &&
      postTrace?.outcome === "completed" &&
      delta["injectorsCreated"] === 2 &&
      delta["injectorsDestroyed"] === 2 &&
      delta["identitiesCreated"] === 2 &&
      delta["identitiesDestroyed"] === 2 &&
      delta["controllersConstructed"] === 2 &&
      delta["controllersDestroyed"] === 2 &&
      delta["guardCleanups"] === 2 &&
      delta["interceptorEntries"] === 4 &&
      delta["interceptorCleanups"] === 4 &&
      delta["handlerCalls"] === 2 &&
      delta["observations"] === 2,
  );

  await scenario(
    "401 and 403 denials run only the guard and its cleanup: no interceptor, factory, injector or controller",
    async () => {
      const labels = [label("missing"), label("invalid"), label("forbidden")];
      const replies = await Promise.all([
        send("101", { tag: "x", trace: labels[0]! }),
        send("101", { tag: "x", trace: labels[1]! }, { token: "invalid" }),
        send("900", { tag: "x", trace: labels[2]! }, { token: "packed-beta" }),
      ]);
      return { replies, labels };
    },
    (replies, delta, traces) =>
      replies.map((reply) => reply.status).join(",") === "401,401,403" &&
      replies.every(
        (reply) => reply.headers.get("cache-control") === "no-store" && !leaks(reply),
      ) &&
      traces.every((trace) => same(trace?.steps, EXPECTED_TRACES.denied)) &&
      traces.map((trace) => `${trace?.outcome}:${trace?.status}:${trace?.phase}`).join(",") ===
        "guard-denied:401:guards,guard-denied:401:guards,guard-denied:403:guards" &&
      delta["guardEntered"] === 3 &&
      delta["guardCleanups"] === 3 &&
      delta["interceptorEntries"] === 0 &&
      delta["factoryCalls"] === 0 &&
      delta["injectorsCreated"] === 0 &&
      delta["controllersConstructed"] === 0 &&
      delta["handlerCalls"] === 0,
  );

  await scenario(
    "invalid params (sync schema) and query (async schema) answer a safe 400 after the injector is destroyed",
    async () => {
      const labels = [label("params"), label("query")];
      const replies = await Promise.all([
        send("abc", { tag: "x", trace: labels[0]! }, { token: "packed-alpha" }),
        send(
          "101",
          { tag: "NOT_VALID_PACKED_PRIVATE_COMPOSITION_CANARY", trace: labels[1]! },
          {
            token: "packed-alpha",
          },
        ),
      ]);
      return { replies, labels };
    },
    ([params, query], delta, traces) =>
      params?.status === 400 &&
      params.body === '{"error":"invalid_request","source":"params"}' &&
      query?.status === 400 &&
      query.body === '{"error":"invalid_request","source":"query"}' &&
      !leaks(params) &&
      !leaks(query) &&
      traces.every(
        (trace) =>
          same(trace?.steps, EXPECTED_TRACES.handlerError) &&
          trace?.outcome === "input-rejected" &&
          trace.status === 400,
      ) &&
      delta["injectorsCreated"] === 2 &&
      delta["injectorsDestroyed"] === 2 &&
      delta["controllersDestroyed"] === 2,
  );

  await scenario(
    "malformed, unsupported and oversized JSON bodies answer 400, 415 and 413 with their injectors destroyed",
    async () => {
      const labels = [label("malformed"), label("unsupported"), label("oversized")];
      const post = (trace: string, body: string, type: string) =>
        send("101", { trace }, { token: "packed-alpha", method: "POST", body, type });
      const replies = await Promise.all([
        post(labels[0]!, "{ PACKED_PRIVATE_COMPOSITION_CANARY", "application/json"),
        post(labels[1]!, "{}", "text/plain"),
        post(
          labels[2]!,
          JSON.stringify({ count: `1${"9".repeat(1024 * 1024)}` }),
          "application/json",
        ),
      ]);
      return { replies, labels };
    },
    (replies, delta, traces) =>
      replies.map((reply) => reply.status).join(",") === "400,415,413" &&
      replies.every((reply) => reply.body.includes('"source":"body"') && !leaks(reply)) &&
      traces.every((trace) => trace?.outcome === "input-rejected") &&
      delta["injectorsCreated"] === 3 &&
      delta["injectorsDestroyed"] === 3,
  );

  await scenario(
    "factory, provider and constructor failures: 500 without private data, each created injector destroyed once",
    async () => {
      const labels = [label("factory"), label("provider"), label("constructor")];
      const replies: Reply[] = [];
      for (const [index, fail] of ["factory", "provider", "constructor"].entries()) {
        replies.push(
          await send("101", { tag: "x", fail, trace: labels[index]! }, { token: "packed-alpha" }),
        );
      }
      return { replies, labels };
    },
    (replies, delta, [factory, provider, construct]) =>
      replies.every((reply) => reply.status === 500 && !leaks(reply)) &&
      same(factory?.steps, EXPECTED_TRACES.factoryError) &&
      same(provider?.steps, EXPECTED_TRACES.providerError) &&
      same(construct?.steps, EXPECTED_TRACES.constructorError) &&
      [factory, provider, construct].every((trace) => trace?.outcome === "failed") &&
      delta["factoryCalls"] === 3 &&
      // The factory failed before creating one; provider and constructor failures created one each.
      delta["injectorsCreated"] === 2 &&
      delta["injectorsDestroyed"] === 2 &&
      // RequestIdentity resolves before the failing provider and before the constructor body.
      delta["identitiesCreated"] === 2 &&
      delta["identitiesDestroyed"] === 2 &&
      delta["controllersConstructed"] === 1 &&
      delta["controllersDestroyed"] === 0 &&
      delta["handlerCalls"] === 0 &&
      delta["guardCleanups"] === 3 &&
      delta["interceptorCleanups"] === 6,
  );

  await scenario(
    "handler failure, interceptor failure before and after next(): safe 500, downstream skipped or unwound",
    async () => {
      const labels = [label("handler"), label("before"), label("after")];
      const replies: Reply[] = [];
      for (const [index, fail] of [
        "handler",
        "interceptor-before",
        "interceptor-after",
      ].entries()) {
        replies.push(
          await send("101", { tag: "x", fail, trace: labels[index]! }, { token: "packed-alpha" }),
        );
      }
      return { replies, labels };
    },
    (replies, delta, [handler, before, after]) =>
      replies.every((reply) => reply.status === 500 && !leaks(reply)) &&
      same(handler?.steps, EXPECTED_TRACES.handlerError) &&
      same(before?.steps, EXPECTED_TRACES.interceptorBefore) &&
      same(after?.steps, EXPECTED_TRACES.interceptorAfter) &&
      [handler, before, after].every((trace) => trace?.outcome === "failed") &&
      delta["factoryCalls"] === 2 &&
      delta["injectorsCreated"] === 2 &&
      delta["injectorsDestroyed"] === 2 &&
      delta["handlerCalls"] === 2,
  );

  await scenario(
    "next() called twice concurrently: configuration failure, the handler runs once, its injector is drained and destroyed",
    async () => {
      const labels = [label("twice")];
      const replies = [
        await send(
          "101",
          { tag: "x", fail: "next-twice", trace: labels[0]! },
          { token: "packed-alpha" },
        ),
      ];
      return { replies, labels };
    },
    ([reply], delta, [trace]) =>
      reply?.status === 500 &&
      !leaks(reply) &&
      trace?.outcome === "failed" &&
      trace.steps.filter((name) => name === "handler").length === 1 &&
      trace.steps.at(-1) === "observed" &&
      same(trace.steps.slice(-5), [...CLEANUP_WITH_INJECTOR, "observed"]) &&
      delta["factoryCalls"] === 1 &&
      delta["handlerCalls"] === 1 &&
      delta["injectorsCreated"] === 1 &&
      delta["injectorsDestroyed"] === 1,
  );

  await scenario(
    "a native Response passes both interceptors unchanged; an interceptor replacement owns the reply",
    async () => {
      const labels = [label("native"), label("replace")];
      const replies = await Promise.all([
        send("101", { tag: "x", native: "true", trace: labels[0]! }, { token: "packed-alpha" }),
        send("101", { tag: "x", replace: "true", trace: labels[1]! }, { token: "packed-beta" }),
      ]);
      return { replies, labels };
    },
    ([native, replaced], delta, traces) =>
      native?.status === 200 &&
      native.body === "packed-native-preserved" &&
      native.headers.get("x-packed-native") === "yes" &&
      native.headers.get("content-type")?.startsWith("text/plain") === true &&
      replaced?.status === 202 &&
      replaced.body === "replaced-by-interceptor" &&
      traces.every(
        (trace) => same(trace?.steps, EXPECTED_TRACES.success) && trace?.outcome === "completed",
      ) &&
      delta["handlerCalls"] === 2 &&
      delta["injectorsCreated"] === 2 &&
      delta["injectorsDestroyed"] === 2,
  );

  await scenario(
    "a StrataAnalogHttpError maps to its safe status only when every cleanup succeeded",
    async () => {
      const labels = [
        label("not-found"),
        label("not-found-cleanup"),
        label("ok-cleanup"),
        label("ok-cleanups"),
      ];
      const replies: Reply[] = [];
      for (const [index, query] of [
        { fail: "not-found" },
        { fail: "not-found", cleanup: "inner" },
        { cleanup: "inner" },
        { cleanup: "both" },
      ].entries()) {
        replies.push(
          await send(
            "101",
            { tag: "x", ...query, trace: labels[index]! },
            { token: "packed-alpha" },
          ),
        );
      }
      return { replies, labels };
    },
    ([notFound, notFoundCleanup, okCleanup, okCleanups], delta, traces) =>
      notFound?.status === 404 &&
      notFound.body === '{"error":"not_found"}' &&
      notFound.headers.get("cache-control") === "no-store" &&
      // A failed cleanup outranks the application error: it must stay visible as a route failure.
      notFoundCleanup?.status === 500 &&
      okCleanup?.status === 500 &&
      okCleanups?.status === 500 &&
      [notFound, notFoundCleanup, okCleanup, okCleanups].every((reply) => !leaks(reply)) &&
      traces[0]?.outcome === "application-error" &&
      traces[0].status === 404 &&
      traces
        .slice(1)
        .every(
          (trace) =>
            trace?.outcome === "cleanup-failed" &&
            trace.cleanup === "failed" &&
            trace.phase === "cleanup" &&
            trace.status === null,
        ) &&
      same(traces[1]?.steps, EXPECTED_TRACES.handlerError) &&
      same(traces[2]?.steps, EXPECTED_TRACES.success) &&
      same(traces[3]?.steps, EXPECTED_TRACES.success) &&
      // Every cleanup still ran exactly once after the failing one (LIFO continues).
      delta["cleanupRuns"] === 16 &&
      delta["guardCleanups"] === 4 &&
      delta["injectorsDestroyed"] === 4,
  );

  results.push(
    check(
      "after a 413 for an oversized JSON body, the SAME keep-alive connection serves the next request (no parser 400)",
      ...(await (async (): Promise<[boolean, string]> => {
        const statuses = await oversizedThenNextOnOneConnection(new URL(base));
        return [JSON.stringify(statuses) === JSON.stringify(["413", "200"]), statuses.join(", ")];
      })()),
    ),
  );

  await scenario(
    "24 concurrent mixed requests: 8 overlapping successes, denials, validation, handler and cleanup failures stay isolated",
    async () => {
      const meeting = `meet-${Date.now()}`;
      const labels: string[] = [];
      const plan = Array.from({ length: 24 }, (_, index) => {
        const trace = label(`mixed-${index}`);
        const token = index % 2 === 0 ? ("packed-alpha" as const) : ("packed-beta" as const);
        labels.push(trace);
        if (index < 8)
          return () => send(String(200 + index), { tag: "m", meet: meeting, trace }, { token });
        if (index < 10) return () => send("101", { tag: "x", trace });
        if (index < 12) return () => send("900", { tag: "x", trace }, { token: "packed-beta" });
        if (index < 16) return () => send("bad", { tag: "x", trace }, { token });
        if (index < 20) return () => send("101", { tag: "x", fail: "handler", trace }, { token });
        return () => send("101", { tag: "x", cleanup: "inner", trace }, { token });
      });
      const replies = await Promise.all(plan.map((request) => request()));
      return { replies, labels };
    },
    (replies, delta, traces, after) => {
      const successes = replies.slice(0, 8);
      const identities = new Set(successes.map((reply) => reply.json?.["identity"]));
      const expected = (index: number): number =>
        index < 8 ? 200 : index < 10 ? 401 : index < 12 ? 403 : index < 16 ? 400 : 500;
      const outcomes = (index: number): string =>
        index < 8
          ? "completed"
          : index < 12
            ? "guard-denied"
            : index < 16
              ? "input-rejected"
              : index < 20
                ? "failed"
                : "cleanup-failed";
      return (
        replies.every((reply, index) => reply.status === expected(index) && !leaks(reply)) &&
        successes.every(
          (reply, index) =>
            reply.json?.["met"] === true &&
            reply.json?.["principal"] === (index % 2 === 0 ? "alpha" : "beta") &&
            (reply.json?.["product"] as { id?: number } | undefined)?.id === 200 + index &&
            reply.json?.["capturedAfterAwait"] === true,
        ) &&
        identities.size === 8 &&
        traces.every((trace, index) => trace?.outcome === outcomes(index)) &&
        delta["guardEntered"] === 24 &&
        delta["guardCleanups"] === 24 &&
        delta["injectorsCreated"] === 20 &&
        delta["injectorsDestroyed"] === 20 &&
        delta["identitiesDestroyed"] === 20 &&
        delta["controllersDestroyed"] === 20 &&
        delta["observations"] === 24 &&
        (after["maxLive"] ?? 0) >= 8
      );
    },
  );

  await scenario(
    "a failed request does not contaminate the next one: fresh identity, own principal, nothing left alive",
    async () => {
      const labels = [label("fail-first"), label("then-succeed")];
      const replies = [
        await send(
          "101",
          { tag: "x", fail: "constructor", trace: labels[0]! },
          { token: "packed-beta" },
        ),
        await send("101", { tag: "after", trace: labels[1]! }, { token: "packed-alpha" }),
      ];
      return { replies, labels };
    },
    ([failed, next], delta, [, nextTrace]) =>
      failed?.status === 500 &&
      next?.status === 200 &&
      next.json?.["principal"] === "alpha" &&
      next.json?.["tag"] === "AFTER" &&
      next.json?.["audit"] === "request-audit" &&
      same(nextTrace?.steps, EXPECTED_TRACES.success) &&
      delta["injectorsCreated"] === 2 &&
      delta["injectorsDestroyed"] === 2,
  );

  return results.every(Boolean);
}

/**
 * One raw keep-alive connection: an authorized POST whose JSON body exceeds the 1 MiB validated
 * limit, then — once the 413 has arrived — a GET on the same socket. Before the fix in
 * `@strata-sc/analog`'s bounded reader, Nitro node-server answered that GET with Node's bare
 * `400 Bad Request` (docs/research/m3-m4-contract-stabilization.md).
 */
function oversizedThenNextOnOneConnection(base: URL): Promise<string[]> {
  const body = JSON.stringify({ count: `1${"9".repeat(1024 * 1024)}` });
  const auth = "authorization: Bearer packed-alpha\r\n";
  const first =
    `POST /api/packed-composition/products/101 HTTP/1.1\r\nhost: ${base.host}\r\n${auth}` +
    `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
    `connection: keep-alive\r\n\r\n${body}`;
  const second =
    `GET /api/packed-composition/products/202?tag=next HTTP/1.1\r\nhost: ${base.host}\r\n${auth}` +
    "connection: close\r\n\r\n";

  return new Promise((resolve, reject) => {
    const socket = connect(Number(base.port), base.hostname);
    let received = "";
    let continued = false;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
      if (!continued && received.includes("payload_too_large")) {
        continued = true;
        socket.write(second);
      }
    });
    socket.on("error", reject);
    socket.on("close", () =>
      resolve([...received.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => match[1] ?? "")),
    );
    socket.write(first);
    setTimeout(() => socket.destroy(), 15_000).unref();
  });
}

/** Files below `dir`, relative to it. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path).map((file) => join(name, file)) : [name];
  });
}

/**
 * The consumer's own server-only DI code (plugin, controllers, providers, tokens, credentials)
 * must be in the Nitro server output and in none of the browser files or their hidden source
 * maps; `@angular/platform-server` and the Strata server packages must not be browser sources.
 */
export function checkConfidentiality(
  consumer: string,
  layout: "node" | "cloudflare" = "node",
): boolean {
  const dist = join(consumer, "dist");
  const files = (dirs: readonly string[]) =>
    dirs.flatMap((dir) => listFiles(join(dist, dir)).map((file) => join(dist, dir, file)));
  // On Cloudflare Pages the Worker bundle is published INSIDE analog/public as `_worker.js/`:
  // it is server code that Pages never serves as an asset.
  const worker = join(dist, "analog", "public", "_worker.js");
  const browser = files(["client", "analog/public"]).filter(
    (file) => layout === "node" || !file.startsWith(`${worker}/`),
  );
  const server = layout === "node" ? files(["analog/server"]) : files(["analog/public/_worker.js"]);
  const text = (file: string): string => readFileSync(file, "utf8");
  const browserJs = browser.filter((file) => file.endsWith(".js"));
  const browserMaps = browser.filter((file) => file.endsWith(".map"));
  const serverJs = server.filter((file) => /\.m?js$/.test(file));
  const serverOnly = [
    "STRATA_PACKED_ANGULAR_DI_SERVER_MARKER",
    "STRATA_PACKED_DI_COMPOSITION_SERVER_MARKER",
    "PACKED_COMPOSITION_REQUEST",
    "PACKED_DI_REQUEST",
    "packed-alpha",
  ];
  const short = (file: string) => relative(dist, file);
  const where = layout === "node" ? "Nitro server output" : "Cloudflare Worker bundle";
  const results = [
    check(
      `${layout}: browser output is not vacuous: JavaScript chunks and hidden source maps exist`,
      browserJs.length > 0 && browserMaps.length > 0,
      `${browserJs.length} js, ${browserMaps.length} maps`,
    ),
  ];

  for (const marker of serverOnly) {
    const inBrowser = browser.filter((file) => text(file).includes(marker));
    results.push(
      check(
        `${layout}: ${marker}: in the ${where} (positive control) and in no browser file or map`,
        serverJs.some((file) => text(file).includes(marker)) && inBrowser.length === 0,
        inBrowser.map(short).join(", "),
      ),
    );
  }

  const sources = browserMaps.flatMap(
    (file) => (JSON.parse(text(file)) as { sources?: string[] }).sources ?? [],
  );
  const serverSources = sources.filter((source) =>
    /\/src\/server\/|@angular\/platform-server|@strata-sc\/(core|analog)\/|nitropack/.test(source),
  );
  results.push(
    check(
      `${layout}: browser source maps name no consumer server file, @angular/platform-server, Nitro or Strata server package`,
      sources.length > 0 && serverSources.length === 0,
      `${sources.length} sources; ${serverSources.slice(0, 5).join(", ")}`,
    ),
  );

  return results.every(Boolean);
}

/**
 * Local workerd, Cloudflare Pages preset, no `nodejs_compat`: Angular's JIT compiler cannot build
 * the consumer's request-scoped providers (`EvalError: Code generation from strings disallowed`),
 * the documented NO-GO (docs/research/analog-di-cross-runtime-lifecycle.md). This pins that the
 * unsupported path fails SAFELY through the installed packages: a generic 500 with nothing
 * private, denials still answered before any factory, every cleanup still run, nothing left
 * alive, and the Worker's supported routes unaffected before and after. It is a negative
 * characterization, not a compatibility claim.
 */
export async function workerdCharacterization(base: string, log: () => string): Promise<boolean> {
  const get = async (path: string, token?: string) => {
    const response = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.text() };
  };
  const stats = async (path: string) =>
    JSON.parse((await get(path)).body) as Record<string, number>;
  const results: boolean[] = [];
  const before = await get("/api/native");
  const controller = await get("/api/products/42");
  const page = await get("/products/42");

  results.push(
    check(
      "workerd: supported routes serve before any DI request (native route, Strata controller, SSR page)",
      before.status === 200 &&
        controller.status === 200 &&
        controller.body.includes('"id":"42"') &&
        page.status === 200 &&
        page.body.includes("<html"),
      `${before.status} ${controller.status} ${page.status}`,
    ),
  );

  const diBefore = await stats("/api/packed-di-stats");
  const compositionBefore = await stats("/api/packed-composition-stats");
  const di = await get("/api/packed-angular-di/item-1", "packed-alpha");
  const composed = await get("/api/packed-composition/products/101?tag=x", "packed-alpha");
  const denied = await get("/api/packed-composition/products/101?tag=x");
  const diAfter = await stats("/api/packed-di-stats");
  const compositionAfter = await stats("/api/packed-composition-stats");
  const after = await get("/api/native");
  // Wrangler flushes the request error shortly after the 500 has been answered.
  const jitCause = await until(() => /Code generation from strings disallowed/.test(log()), 10_000);
  const delta = (a: Record<string, number>, b: Record<string, number>, key: string) =>
    (b[key] ?? 0) - (a[key] ?? 0);

  results.push(
    check(
      "workerd: both Angular DI routes answer a generic 500 with no credential, marker or canary",
      di.status === 500 &&
        composed.status === 500 &&
        [di, composed].every(
          ({ body }) =>
            !CANARIES.some((canary) => body.includes(canary)) &&
            !body.includes("STRATA_PACKED_ANGULAR_DI_SERVER_MARKER"),
        ),
      `${di.status} ${composed.status}`,
    ),
    check(
      "workerd: the cause is the documented Angular JIT restriction (code generation from strings)",
      jitCause === true,
      log().slice(-600),
    ),
    check(
      "workerd: a denial is still answered 401 before any interceptor or factory (one authorized attempt reached the factory)",
      denied.status === 401 &&
        delta(compositionBefore, compositionAfter, "guardEntered") === 2 &&
        // Only the authorized request entered the two interceptors; the denial entered none.
        delta(compositionBefore, compositionAfter, "interceptorEntries") === 2 &&
        delta(compositionBefore, compositionAfter, "factoryCalls") === 1,
      JSON.stringify(compositionAfter),
    ),
    check(
      "workerd: the failed DI requests still ran every cleanup and left no request injector alive",
      delta(diBefore, diAfter, "injectorsCreated") === 0 &&
        delta(diBefore, diAfter, "guardCleanups") === 1 &&
        delta(compositionBefore, compositionAfter, "injectorsCreated") === 0 &&
        delta(compositionBefore, compositionAfter, "guardCleanups") === 2 &&
        delta(compositionBefore, compositionAfter, "interceptorCleanups") === 2 &&
        delta(compositionBefore, compositionAfter, "duplicateCleanups") === 0 &&
        compositionAfter["live"] === 0 &&
        diAfter["live"] === 0,
      `${JSON.stringify(diAfter)} ${JSON.stringify(compositionAfter)}`,
    ),
    check(
      "workerd: the Worker keeps serving supported routes after the DI failures",
      after.status === 200 && after.body.includes('"source":"analog"'),
    ),
  );

  return results.every(Boolean);
}
