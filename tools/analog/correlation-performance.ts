import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import { registerControllers } from "../../packages/analog/dist/index.js";
import type { NitroRouter, RegisterControllersOptions } from "../../packages/analog/dist/index.js";
import { Controller, Get } from "../../packages/core/dist/index.js";

/**
 * `pnpm test:analog-correlation-performance`: the cost of `requestCorrelation`
 * (docs/research/analog-request-correlation-v012.md). The same in-process workload
 * (guard + interceptor + factory + handler) runs with correlation disabled and enabled,
 * rounds interleaved so drift hits both alike; the median of the rounds is reported.
 * A relative, same-machine measurement, not a throughput claim.
 */

const requireFromAnalog = createRequire(
  new URL("../../packages/analog/package.json", import.meta.url),
);
const h3 = requireFromAnalog("h3") as {
  createApp: () => { use: (handler: unknown) => void };
  createRouter: (options: { preemptive: boolean }) => NitroRouter & { handler: unknown };
  toWebHandler: (app: unknown) => (request: Request) => Promise<Response>;
};

type DecoratorTarget = (...args: never[]) => unknown;

function workloadController(): new () => object {
  const metadata = {} as DecoratorMetadata;

  class Measured {}

  const handler: DecoratorTarget = function measuredHandler() {
    return { ok: true };
  };
  Object.defineProperty(Measured.prototype, "run", { value: handler });
  (Get("/run") as unknown as (target: DecoratorTarget, context: unknown) => void)(handler, {
    kind: "method",
    name: "run",
    metadata,
    static: false,
    private: false,
  });
  (Controller("/bench") as unknown as (target: DecoratorTarget, context: unknown) => void)(
    Measured,
    { kind: "class", name: "Measured", metadata },
  );
  Object.defineProperty(Measured, Symbol.metadata, { value: metadata });

  return Measured;
}

let observed = 0;

function build(options: RegisterControllersOptions) {
  const app = h3.createApp();
  const router = h3.createRouter({ preemptive: true });

  registerControllers(router, [workloadController()], {
    guards: [() => ({ allow: true })],
    interceptors: [(_context, next) => next()],
    onRequestSettled: () => {
      observed += 1;
    },
    ...options,
  });
  app.use(router.handler);

  return h3.toWebHandler(app);
}

const MODES = {
  disabled: build({}),
  enabled: build({ requestCorrelation: true }),
} as const;

const ROUNDS = 9;
const REQUESTS = 4_000;
const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function round(handle: (request: Request) => Promise<Response>): Promise<number> {
  const request = () => new Request("http://localhost/bench/run");
  const start = performance.now();

  for (let index = 0; index < REQUESTS; index += 1) await (await handle(request())).text();

  return ((performance.now() - start) * 1000) / REQUESTS;
}

for (const handle of Object.values(MODES)) await round(handle); // warm-up

const samples: Record<keyof typeof MODES, number[]> = { disabled: [], enabled: [] };

for (let index = 0; index < ROUNDS; index += 1) {
  const order =
    index % 2 === 0 ? (["disabled", "enabled"] as const) : (["enabled", "disabled"] as const);

  for (const mode of order) samples[mode].push(await round(MODES[mode]));
}

const disabled = median(samples.disabled);
const enabled = median(samples.enabled);

console.log(`requests per round: ${REQUESTS}, rounds: ${ROUNDS}, observed: ${observed}`);
console.log(`disabled: median ${disabled.toFixed(2)} us/request`);
console.log(`enabled:  median ${enabled.toFixed(2)} us/request`);
console.log(
  `delta: ${(enabled - disabled).toFixed(2)} us/request (${(((enabled - disabled) / disabled) * 100).toFixed(1)} %)`,
);
console.log(
  `throughput: disabled ${Math.round(1e6 / disabled)} req/s, enabled ${Math.round(1e6 / enabled)} req/s`,
);

// Retained state: nothing may accumulate per request (no cache, map or history).
const gc = (globalThis as { gc?: () => void }).gc;

if (gc) {
  const heap = async (handle: (request: Request) => Promise<Response>): Promise<number> => {
    gc();
    const before = process.memoryUsage().heapUsed;

    for (let index = 0; index < 20_000; index += 1) {
      await (await handle(new Request("http://localhost/bench/run"))).text();
    }
    gc();

    return process.memoryUsage().heapUsed - before;
  };

  await heap(MODES.enabled);
  console.log(
    `retained heap after 20000 requests (after GC): disabled ${String(await heap(MODES.disabled))} B, enabled ${String(await heap(MODES.enabled))} B`,
  );
} else {
  console.log("retained heap: skipped (run with --expose-gc)");
}
