import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Controller,
  Delete,
  Get,
  Post,
  getControllerDefinition,
  STRATA_VERSION,
} from "@strata-sc/core";
import {
  registerControllers,
  StrataAnalogConfigurationError,
  type StrataAnalogControllerFactory,
  type StrataAnalogGuard,
} from "@strata-sc/analog";
import { createApp, createRouter, toNodeListener } from "h3";

import {
  constructedControllers,
  FailingController,
  LifecycleController,
} from "./lifecycle.controller.js";
import { BaseController, DecoratedChild, UndecoratedChild } from "./inheritance.controller.js";
import { DuplicateCreateController, ItemsController } from "./items.controller.js";
import { PostsController, registerPosts } from "./posts.controller.js";
import { UnregisteredController } from "./registration.controller.js";
import { ValidatedController } from "./validated.controller.js";

// --- Registration ----------------------------------------------------------
assert.deepEqual(getControllerDefinition(PostsController), {
  path: "/api/posts",
  routes: [
    { method: "GET", path: "/:id", handler: "findOne" },
    { method: "GET", path: "/", handler: "findAll" },
  ],
});

// --- Every HTTP method decorator from the packed @strata-sc/core -------------
assert.deepEqual(getControllerDefinition(ItemsController), {
  path: "/api/items",
  routes: [
    { method: "GET", path: "/", handler: "list" },
    { method: "POST", path: "/", handler: "create" },
    { method: "PUT", path: "/:id", handler: "replace" },
    { method: "PATCH", path: "/:id", handler: "update" },
    { method: "DELETE", path: "/:id", handler: "remove" },
  ],
});

// --- Class-local metadata: no implicit controller or route inheritance ------
const baseDefinition = {
  path: "/api/base",
  routes: [{ method: "GET", path: "/one", handler: "one" }],
};
assert.equal(getControllerDefinition(UndecoratedChild), undefined);
assert.deepEqual(getControllerDefinition(BaseController), baseDefinition);
assert.deepEqual(getControllerDefinition(DecoratedChild), {
  path: "/api/child",
  routes: [{ method: "GET", path: "/two", handler: "two" }],
});
assert.throws(
  () => registerControllers(createRouter(), [UndecoratedChild]),
  (error: unknown) =>
    error instanceof StrataAnalogConfigurationError &&
    error.message.includes("is not a Strata controller"),
);

// H3 v1's Router is the router Nitro 2 exposes as `nitroApp.router`; it must
// satisfy `NitroRouter` structurally, without a cast.
const router = createRouter();
assert.equal(registerPosts(router), router);
assert.throws(
  () => registerControllers(router, [class NotAController {}]),
  StrataAnalogConfigurationError,
);

const cleanupLog: string[] = [];
const guardCleanup: string[] = [];
let guardedConstructors = 0;
@Controller("/api/guarded")
class GuardedController {
  constructor() {
    guardedConstructors += 1;
  }
  @Get("/:id") get() {
    return { public: true };
  }
  @Post() create() {
    return { created: true };
  }
  @Delete("/:id") remove() {
    return { removed: true };
  }
}
const guard: StrataAnalogGuard = async ({ request, route, onCleanup }) => {
  onCleanup(() => {
    guardCleanup.push(request.path);
  });
  await Promise.resolve();
  if (route.method === "GET") return { allow: true };
  const token = request.headers.get("authorization");
  if (token !== "Bearer ada" && token !== "Bearer grace") return { allow: false, status: 401 };
  if (route.method === "DELETE" && token !== `Bearer ${request.params["id"]}`) {
    return { allow: false, status: 403 };
  }
  return { allow: true };
};
registerControllers(router, [GuardedController], { guards: [guard] });
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
registerControllers(router, [BaseController, DecoratedChild]);
registerControllers(router, [ItemsController]);
registerControllers(router, [ValidatedController]);

// Same path, different method is fine (above); same method and path is not.
assert.throws(
  () => registerControllers(router, [DuplicateCreateController]),
  (error: unknown) =>
    error instanceof StrataAnalogConfigurationError &&
    error.message.includes('Duplicate Strata route "POST /api/items"'),
);

// --- Registration: duplicates fail, a failed batch commits nothing ----------
const isDuplicateError = (error: unknown) =>
  error instanceof StrataAnalogConfigurationError &&
  error.message.includes('Duplicate Strata route "GET /api/posts/:id"');
assert.throws(() => registerPosts(router), isDuplicateError);
assert.throws(
  () => registerControllers(router, [UnregisteredController, PostsController]),
  isDuplicateError,
);

const app = createApp();
app.use(router);

const server = createServer(toNodeListener(app));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

async function send(
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(json === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(json) }),
  });

  return { status: response.status, body: await response.json() };
}

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

  // --- HTTP method table: each request reaches only its own handler --------
  const methodTable = [
    [send("GET", "/api/items"), { handler: "list", method: "GET" }],
    [
      send("POST", "/api/items", { name: "Ada" }),
      { handler: "create", method: "POST", name: "Ada" },
    ],
    [send("PUT", "/api/items/7"), { handler: "replace", method: "PUT", id: "7" }],
    [
      send("PATCH", "/api/items/42", { name: "Grace" }),
      { handler: "update", id: "42", name: "Grace" },
    ],
    [send("DELETE", "/api/items/42"), { handler: "remove", method: "DELETE", deleted: "42" }],
  ] as const;

  for (const [response, body] of methodTable) {
    assert.deepEqual(await response, { status: 200, body });
  }

  assert.deepEqual(await send("POST", "/api/validated", { count: "12" }), {
    status: 200,
    body: { count: 12 },
  });
  const invalidValidated = await fetch(`http://127.0.0.1:${port}/api/validated`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: "private fixture message" }),
  });
  assert.equal(invalidValidated.status, 400);
  assert.equal(invalidValidated.headers.get("cache-control"), "no-store");
  assert.deepEqual(await invalidValidated.json(), { error: "invalid_request", source: "body" });

  const guardedBefore = guardedConstructors;
  const denied = await fetch(`http://127.0.0.1:${port}/api/guarded`, { method: "POST" });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.deepEqual(await denied.json(), { error: "unauthorized" });
  assert.equal(guardedConstructors, guardedBefore);
  const forbidden = await fetch(`http://127.0.0.1:${port}/api/guarded/grace`, {
    method: "DELETE",
    headers: { authorization: "Bearer ada" },
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "forbidden" });
  assert.equal(guardedConstructors, guardedBefore);
  const publicRoute = await fetch(`http://127.0.0.1:${port}/api/guarded/any`);
  assert.equal(publicRoute.status, 200);
  assert.deepEqual(await publicRoute.json(), { public: true });
  const authorized = await fetch(`http://127.0.0.1:${port}/api/guarded`, {
    method: "POST",
    headers: { authorization: "Bearer ada" },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { created: true });
  const guardedConcurrent = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const kind = index % 4;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/guarded${kind === 0 ? "" : `/${kind === 3 ? "grace" : "ada"}`}`,
        {
          method: kind === 0 ? "POST" : kind === 1 || kind === 3 ? "DELETE" : "GET",
          ...(kind === 0
            ? {}
            : { headers: { authorization: kind === 2 ? "Bearer invalid" : "Bearer ada" } }),
        },
      );
      const expectedStatus = kind === 0 ? 401 : kind === 1 ? 200 : kind === 2 ? 200 : 403;
      return { status: response.status, expectedStatus, kind };
    }),
  );
  assert.deepEqual(
    guardedConcurrent.filter(({ status, expectedStatus }) => status !== expectedStatus),
    [],
  );
  assert.equal(guardCleanup.length, 28);

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

  // --- Parent and decorated child serve only their own routes ---------------
  assert.deepEqual(await get("/api/base/one"), { status: 200, body: { route: "one" } });
  assert.deepEqual(await get("/api/child/two"), { status: 200, body: { route: "two" } });
  assert.equal((await get("/api/child/one")).status, 404);
  assert.equal((await get("/api/base/two")).status, 404);

  // The failed batch above left no handler for its free route.
  assert.equal((await get("/api/unregistered")).status, 404);

  const failure = await get("/api/failing");
  assert.equal(failure.status, 500);
  assert.deepEqual(cleanupLog.slice(-2), ["async /api/failing", "sync /api/failing"]);

  console.log(
    `PACKAGE_CONSUMER_RESULT ${JSON.stringify({
      strataVersion: STRATA_VERSION,
      resolved: {
        core: import.meta.resolve("@strata-sc/core"),
        analog: import.meta.resolve("@strata-sc/analog"),
      },
      requests: results.length + 8 + methodTable.length,
      cleanups: cleanupLog.length,
    })}`,
  );
  console.log("PACKAGE_CONSUMER_OK");
} finally {
  server.close();
}
