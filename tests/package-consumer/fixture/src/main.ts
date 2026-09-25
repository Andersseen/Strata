import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { getControllerDefinition, STRATA_VERSION } from "@strata/core";
import {
  registerControllers,
  StrataAnalogConfigurationError,
  type StrataAnalogControllerFactory,
} from "@strata/analog";
import { createApp, createRouter, toNodeListener } from "h3";

import {
  constructedControllers,
  FailingController,
  LifecycleController,
} from "./lifecycle.controller.js";
import { PostsController, registerPosts } from "./posts.controller.js";

// --- Registration ----------------------------------------------------------
assert.deepEqual(getControllerDefinition(PostsController), {
  path: "/api/posts",
  routes: [
    { method: "GET", path: "/:id", handler: "findOne" },
    { method: "GET", path: "/", handler: "findAll" },
  ],
});

// H3 v1's Router is the router Nitro 2 exposes as `nitroApp.router`; it must
// satisfy `NitroRouter` structurally, without a cast.
const router = createRouter();
assert.equal(registerPosts(router), router);
assert.throws(
  () => registerControllers(router, [class NotAController {}]),
  StrataAnalogConfigurationError,
);

const cleanupLog: string[] = [];
const controllerFactory: StrataAnalogControllerFactory = async (Controller, context) => {
  const { request, onCleanup } = context;
  onCleanup(() => {
    cleanupLog.push(`sync ${request.path}`);
  });
  onCleanup(async () => {
    await Promise.resolve();
    cleanupLog.push(`async ${request.path}`);
  });
  await Promise.resolve();

  return new Controller();
};
registerControllers(router, [LifecycleController, FailingController], { controllerFactory });

const app = createApp();
app.use(router);

const server = createServer(toNodeListener(app));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);

  return { status: response.status, body: await response.json() };
}

try {
  // --- GET, dynamic params, query ------------------------------------------
  assert.deepEqual(await get("/api/posts/42"), { status: 200, body: { id: "42" } });
  assert.deepEqual(await get("/api/posts?tag=a&tag=b&draft=true"), {
    status: 200,
    body: { query: { tag: ["a", "b"], draft: "true" } },
  });

  // --- Controller creation + request isolation under concurrency -----------
  const before = constructedControllers();
  const slugs = Array.from({ length: 8 }, (_, index) => `post-${index}`);
  const results = await Promise.all(
    slugs.map((slug, index) => get(`/api/lifecycle/${slug}?delay=${(slugs.length - index) * 5}`)),
  );
  const bodies = results.map(({ status, body }) => {
    assert.equal(status, 200);

    return body as { slug: string; instance: number };
  });

  assert.deepEqual(
    bodies.map(({ slug }) => slug),
    slugs,
  );
  assert.equal(constructedControllers() - before, slugs.length);
  assert.equal(new Set(bodies.map(({ instance }) => instance)).size, slugs.length);

  // --- Cleanup: once per request, LIFO, before the response, also on error -
  for (const slug of slugs) {
    const path = `/api/lifecycle/${slug}`;
    assert.deepEqual(
      cleanupLog.filter((entry) => entry.endsWith(` ${path}`)),
      [`async ${path}`, `sync ${path}`],
    );
  }

  const failure = await get("/api/failing");
  assert.equal(failure.status, 500);
  assert.deepEqual(cleanupLog.slice(-2), ["async /api/failing", "sync /api/failing"]);

  console.log(
    `PACKAGE_CONSUMER_RESULT ${JSON.stringify({
      strataVersion: STRATA_VERSION,
      resolved: {
        core: import.meta.resolve("@strata/core"),
        analog: import.meta.resolve("@strata/analog"),
      },
      requests: results.length + 3,
      cleanups: cleanupLog.length,
    })}`,
  );
  console.log("PACKAGE_CONSUMER_OK");
} finally {
  server.close();
}
