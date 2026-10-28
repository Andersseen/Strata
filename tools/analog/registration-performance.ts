import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import { registerControllers } from "../../packages/analog/dist/index.js";
import type { NitroRouter } from "../../packages/analog/dist/index.js";
import { Controller, Get } from "../../packages/core/dist/index.js";

const requireFromAnalog = createRequire(
  new URL("../../packages/analog/package.json", import.meta.url),
);
const { createRouter } = requireFromAnalog("h3") as {
  createRouter: (options: { preemptive: boolean }) => NitroRouter;
};

type DecoratorTarget = (...args: never[]) => unknown;

const ROUTE_COUNTS = [1, 100, 400] as const;
const REPETITIONS = 9;

function controllerWithRoutes(count: number): new () => object {
  const metadata = {} as DecoratorMetadata;

  class MeasuredController {}

  for (let index = 0; index < count; index += 1) {
    const name = `route${index}`;
    const handler: DecoratorTarget = function measuredHandler() {};
    Object.defineProperty(MeasuredController.prototype, name, { value: handler });
    (Get(`/route-${index}`) as unknown as (target: DecoratorTarget, context: unknown) => void)(
      handler,
      {
        kind: "method",
        name,
        metadata,
        static: false,
        private: false,
      },
    );
  }

  (Controller("/catalog") as unknown as (target: DecoratorTarget, context: unknown) => void)(
    MeasuredController,
    { kind: "class", name: "MeasuredController", metadata },
  );
  Object.defineProperty(MeasuredController, Symbol.metadata, { value: metadata });

  return MeasuredController;
}

function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

for (const count of ROUTE_COUNTS) {
  const samples: number[] = [];

  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    const controller = controllerWithRoutes(count);
    const router = createRouter({ preemptive: true });
    const start = performance.now();
    registerControllers(router, [controller]);
    samples.push(performance.now() - start);
  }

  console.log(
    `${count} routes: median registration ${median(samples).toFixed(3)} ms (n=${REPETITIONS})`,
  );
}
