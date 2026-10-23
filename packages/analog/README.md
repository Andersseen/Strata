# @strata-sc/analog

Experimental [Analog](https://analogjs.org) 2 adapter for
[Strata](https://github.com/Andersseen/Strata): registers `@strata-sc/core`
controllers on the Nitro router from a Nitro server plugin. It does not depend
on `h3`, `nitropack` or `@analogjs/*`, and its declarations do not expose
H3/Nitro types.

```bash
pnpm add @strata-sc/core@next @strata-sc/analog@next
```

```ts
// src/server/strata/posts.controller.ts
import { Controller, Delete, Get, Post } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";
import { z } from "zod";

const productParams = z.object({ id: z.string().transform(Number) });
const createProduct = z.object({ name: z.string().min(1) });

@Controller("/api/posts")
export class PostsController {
  @Get("/:id")
  async findOne(request: StrataAnalogRequest) {
    const { id } = await request.validateParams(productParams);
    return { id };
  }

  @Post()
  async create(request: StrataAnalogRequest) {
    return request.readValidatedJson(createProduct);
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    return { deleted: request.params["id"] };
  }
}
```

```ts
// src/server/plugins/strata.ts
import { registerControllers } from "@strata-sc/analog";
import type { StrataAnalogGuard, StrataAnalogInterceptor } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { PostsController } from "../strata/posts.controller";

const requireAuth: StrataAnalogGuard = ({ request, route, onCleanup }) => {
  // Verify credentials with application-owned code. Never trust an identity
  // copied from a query parameter or arbitrary header.
  const token = request.headers.get("authorization");
  onCleanup(() => releaseRequestResources());
  if (!verifyToken(token)) return { allow: false, status: 401 };
  if (route.method === "DELETE" && !canDelete(token, request.params["id"])) {
    return { allow: false, status: 403 };
  }
  return { allow: true };
};

const timingInterceptor: StrataAnalogInterceptor = async (context, next) => {
  const started = performance.now();
  try {
    return await next();
  } finally {
    recordDuration(context.route, performance.now() - started);
  }
};

const loggingInterceptor: StrataAnalogInterceptor = async ({ route }, next) => {
  try {
    return await next();
  } catch (error) {
    // Record only stable route metadata. Do not log credentials or request data.
    recordSanitizedFailure(route.method, route.path);
    throw error;
  }
};

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [PostsController], {
    guards: [requireAuth],
    interceptors: [timingInterceptor, loggingInterceptor],
  });
});
```

Guards are opt-in and run sequentially before a controller is constructed.
Each receives the current request, immutable route metadata (`method`, final
registered `path`, controller name and handler name), and the same request-local
`onCleanup` used by the controller factory. Return exactly `{ allow: true }` or
`{ allow: false, status: 401 | 403 }`. Denials use generic JSON and
`Cache-Control: no-store`; malformed decisions and thrown/rejected guards are
application failures. Authentication and authorization remain consumer-owned:
Strata does not verify credentials, manage sessions or provide RBAC/ABAC.
Guards do not supply CSRF policy or production tenant-isolation certification.
Interceptors may optionally wrap controller execution. Guards always run first;
interceptors then enter in registration order and unwind in reverse order. Each
normally completing interceptor must call and await `next()` exactly once.
An interceptor can inspect, transform or rethrow downstream results and errors.
It cannot short-circuit execution. Interceptors are consumer policy, not an
authentication or general middleware system; real application adoption and
Strata 1.0 remain unqualified.

The interceptor context contains the immutable route information, request and
the existing request cleanup hook. Results flow directly to Nitro. Plain data
can be transformed; a native `Response` passed through unchanged retains its
headers, status, body and streaming behavior. Interceptors should not read a
response body just to log it. Errors propagate to Nitro unless consumer code
deliberately catches and replaces one. Such replacement is consumer policy.
Cleanup runs after interceptor unwinding and preserves the existing LIFO and
`AggregateError` rules. Do not log credentials, request bodies or private
validation issues. Production tracing and client-disconnect cancellation are not
qualified. A response body outlives the invocation only through
[`streamResponse()`](#streaming-responses); an ordinary `Response` does not.

Every `@strata-sc/core` HTTP decorator (`Get`, `Post`, `Put`, `Patch`,
`Delete`) is registered for its own method on the Nitro router, and all of them
run through the same request-scoped invocation. Handlers receive a
`StrataAnalogRequest` with `method`, params, query, headers and lazy body
readers (`readJson()`, `readText()`, `readBody()`).

Validation is opt-in through `validateParams(schema)`, `validateQuery(schema)`
and `readValidatedJson(schema)`. These accept Standard Schema v1 schemas and
return the schema's inferred output type, including transformations. Validators
may run synchronously or asynchronously. Zod, Valibot and other conforming
libraries work; Analog has no runtime dependency on a schema library.

`validateParams` sees matched route params as strings, preserving Nitro routing
and URL decoding. `validateQuery` keeps a single value as a string and repeated
values as arrays; it performs no implicit coercion. Empty query objects are
valid inputs. A schema may transform or coerce values explicitly.

`readValidatedJson` accepts `application/json` and `application/*+json`, with
UTF-8 (or no declared charset). The default maximum is 1 MiB of consumed body
bytes. Call it before any raw body reader so Analog can enforce the bound on
the original body. After it runs, raw readers can reuse that request's text.
Calling a raw reader first and then `readValidatedJson` is a configuration
error because the bytes may already have been consumed without a bound. Empty
JSON bodies validate as `undefined`.

Expected input failures return safe JSON with `Cache-Control: no-store`:

| Status | Error                    | Trigger                                |
| ------ | ------------------------ | -------------------------------------- |
| 400    | `invalid_request`        | malformed JSON or schema issues        |
| 413    | `payload_too_large`      | body exceeds 1 MiB                     |
| 415    | `unsupported_media_type` | unsupported JSON media type or charset |

Responses include a stable `source` (`params`, `query` or `body`) and never
include schema issue messages or request values. A validator that throws or
rejects is an application failure, not a 400. A malformed Standard Schema
contract is a configuration error. Validation failures still run cleanup;
cleanup failures retain precedence and are not converted to input responses.

`readJson<T>()` remains unchecked. Validation is opt-in. It does not provide
authentication or authorization; guards and interceptors remain future work.
Unexpected SSR failures are outside this input contract. M3 and Strata 1.0
remain unqualified.

Controllers are request-scoped. An optional `controllerFactory` (sync or async)
creates each request's controller and can register `onCleanup` callbacks that
run after the invocation settles. A handler that returns
[`streamResponse()`](#streaming-responses) keeps them open until its body ends.

## Application HTTP contract

Controllers and interceptors can throw an expected application error with a
conservative status and stable machine-readable code:

```ts
import { StrataAnalogHttpError } from "@strata-sc/analog";

throw new StrataAnalogHttpError(404, "not_found", "Product 42 is absent");
```

Recognized statuses are `400`, `404`, `409`, `422`, `429` and `503`. Codes
must match `^[a-z][a-z0-9_]{0,63}$`. The constructor rejects unsupported
statuses and malformed codes. The optional message and `ErrorOptions` (including
`cause`) stay available to server-side diagnostics. The public response uses
only `{ "error": "not_found" }`, `application/json; charset=utf-8` and
`Cache-Control: no-store`; it never serializes a message, cause, stack, custom
details or schema issues. Unexpected exceptions keep Nitro's existing error
behavior. Guard-owned 401/403 and validated-input 400/413/415 responses keep
their existing contracts.

Errors are translated only after the request's one `CleanupScope` completes
successfully. A cleanup failure, including an `AggregateError`, remains a
server failure and is not hidden behind an application status or guard denial.
Interceptors may observe and rethrow application errors; their order,
`next()` rules and reverse unwind behavior are unchanged.

Use the native Web `Response` API for explicit response statuses and headers:

```ts
import { jsonResponse, noContent } from "@strata-sc/analog";

return jsonResponse({ id: product.id }, { status: 201 });
return noContent({ headers: { "x-deleted-product": product.id } });
```

`jsonResponse(value, init?)` defaults to 200, serializes once, keeps supplied
headers (including multiple `Set-Cookie` values), and supplies
`application/json; charset=utf-8` only when no content type was supplied. It
uses native `Response` validation for body/status combinations, so JSON with
204/205/304 and unsupported serialization throw. `noContent(init?)` always
returns an empty 204 and does not add a content type. Both preserve caller
headers such as `Cache-Control`. Plain return values and native `Response`
objects remain supported; Nitro routes do not pass through this adapter.

### Complete consumer example

This example is also typechecked from the packed consumer fixture at
[`http-contract-example.ts`](../../tests/full-stack-package-consumer/fixture/src/check/http-contract-example.ts).
The token table and in-memory map are fixture-sized examples; real applications
own credential verification and storage.

```ts
import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import {
  StrataAnalogHttpError,
  jsonResponse,
  noContent,
  registerControllers,
} from "@strata-sc/analog";
import type {
  StrataAnalogGuard,
  StrataAnalogInterceptor,
  StrataAnalogRequest,
} from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";
import { z } from "zod";

const products = new Map<number, { id: number; name: string; status: "active" | "archived" }>([
  [1, { id: 1, name: "Keyboard", status: "active" }],
]);
const owners = new Map<number, string>([[1, "ada"]]);
const tokens = new Map<string, string>([["fixture-token", "ada"]]);
const durations: number[] = [];
const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const querySchema = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
const createSchema = z.object({ name: z.string().trim().min(1) });
const patchSchema = z.object({ name: z.string().trim().min(1) });
let nextId = 2;

@Controller("/api/products")
class ProductsController {
  @Get("/:id")
  async get(request: StrataAnalogRequest) {
    const { id } = await request.validateParams(paramsSchema);
    const { includeArchived } = await request.validateQuery(querySchema);
    const product = products.get(id);
    if (!product || (product.status === "archived" && !includeArchived)) {
      throw new StrataAnalogHttpError(404, "not_found");
    }
    return jsonResponse(product);
  }

  @Post()
  async post(request: StrataAnalogRequest) {
    const input = await request.readValidatedJson(createSchema);
    const duplicate = [...products.values()].some((product) => product.name === input.name);
    if (duplicate) throw new StrataAnalogHttpError(409, "conflict");
    const product = { id: nextId++, name: input.name, status: "active" as const };
    products.set(product.id, product);
    owners.set(product.id, "ada");
    return jsonResponse(product, { status: 201, headers: { "cache-control": "no-store" } });
  }

  @Patch("/:id")
  async patch(request: StrataAnalogRequest) {
    const { id } = await request.validateParams(paramsSchema);
    const input = await request.readValidatedJson(patchSchema);
    const product = products.get(id);
    if (!product) throw new StrataAnalogHttpError(404, "not_found");
    if (product.status !== "active") {
      throw new StrataAnalogHttpError(422, "invalid_product_state");
    }
    const updated = { ...product, name: input.name };
    products.set(id, updated);
    return jsonResponse(updated);
  }

  @Delete("/:id")
  async delete(request: StrataAnalogRequest) {
    const { id } = await request.validateParams(paramsSchema);
    if (!products.delete(id)) throw new StrataAnalogHttpError(404, "not_found");
    owners.delete(id);
    return noContent();
  }
}

const requireOwner: StrataAnalogGuard = ({ request, route }) => {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const principal = tokens.get(token);
  if (!principal) return { allow: false, status: 401 };
  const rawId = request.params["id"];
  const owner = rawId === undefined ? undefined : owners.get(Number(rawId));
  if (owner !== undefined && owner !== principal) return { allow: false, status: 403 };
  return { allow: true };
};

const timing: StrataAnalogInterceptor = async (_context, next) => {
  const started = performance.now();
  try {
    return await next();
  } finally {
    durations.push(performance.now() - started);
  }
};

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [ProductsController], {
    guards: [requireOwner],
    interceptors: [timing],
  });
});
```

The complete consumer fixture checks the public declarations and exercises
these APIs from package tarballs installed outside the pnpm workspace. See the
[HTTP contract qualification](../../docs/research/analog-http-contract-v05.md)
for runtime and release evidence.

## Streaming responses

Cleanup callbacks normally run when the handler settles, which is too early for a
response body that is still being read: an ordinary `Response` over a
`ReadableStream` finds its request-scoped resources already closed. Return
`streamResponse()` to keep them open for the life of the body:

```ts
import { Controller, Get } from "@strata-sc/core";
import { streamResponse } from "@strata-sc/analog";
import type { StrataAnalogControllerFactory } from "@strata-sc/analog";

class OrderCursor {
  async *rows(): AsyncGenerator<string> {
    /* reads from a connection that must stay open */
  }
  close(): void {}
}

@Controller("/api/orders")
class OrdersController {
  constructor(private readonly cursor: OrderCursor) {}

  @Get("/export")
  export() {
    return streamResponse(this.cursor.rows(), {
      headers: { "content-type": "application/x-ndjson" },
    });
  }
}

const controllerFactory: StrataAnalogControllerFactory = (_Controller, { onCleanup }) => {
  const cursor = new OrderCursor();
  onCleanup(() => cursor.close());
  return new OrdersController(cursor);
};
```

`streamResponse(body, init?)` takes an async iterable of strings (UTF-8 encoded)
or `Uint8Array` and returns a native `Response`. It is opt-in: Strata never
infers ownership from a response's shape, because every buffered `Response` also
has a `ReadableStream` body.

**Lifetime.** After the handler and all interceptors settle, the adapter binds the
invocation's cleanup scope to the response. It stays open until the first of:

- the body completes;
- the body iterable throws;
- the consumer cancels the body (`response.body.cancel()`, or a transport
  cancelling its reader).

Then the cleanups run once, last registered first and awaited, exactly as for an
ordinary request. The body is pulled lazily, one chunk per read, never ahead of
the consumer. A cleanup registered while the stream runs (through the factory's
`onCleanup`) is still accepted.

**Errors.** Status and headers are committed when the first chunk is written, so
nothing after that can change the HTTP status. A body that throws errors the
stream with that error, after the cleanups have run; if cleanups also fail the
stream errors with an `AggregateError` of the body error followed by every cleanup
error. A cleanup that fails after a complete body errors the stream instead of
ending it cleanly. No message or stack is ever written to the response body by
Strata; what the client observes of an errored stream is up to the transport (see
below). Before the first chunk, guards, validation and handler errors behave as for
any request: a denied or invalid request never starts a stream.

**Interceptors.** Passing the same `Response` through, and reading its headers or
status, keeps the stream owned. Replacing it with another response (including
`new Response(original.body, …)`) hands ownership to nobody: the scope closes at
once as for an ordinary request, and the abandoned body fails with a
`StrataAnalogConfigurationError` if anything reads it. Reading the body before the
adapter owns it fails the invocation the same way; so does returning one
`streamResponse()` object from two invocations.

**HEAD.** A derived `HEAD` request cancels the body, which releases the resources.

**What the transport decides.** Release depends on the transport reading the body
to its end or cancelling it. Qualified on the pinned tuple (Analog 2.7.2, Nitro
2.13.4, H3 1.15.11), see
[the evidence](../../docs/research/analog-stream-lifecycle-v07.md):

| Behavior                                 | Node (`node-server`, Vite dev) | Cloudflare Pages (local workerd) |
| ---------------------------------------- | ------------------------------ | -------------------------------- |
| Chunks delivered incrementally           | yes                            | **no: the body is buffered**     |
| Resources released once after the body   | yes                            | yes                              |
| Client disconnect releases the resources | **no**: when the body ends     | **no**: when the body ends       |
| Body error after the first chunk         | connection left open, no end   | empty `200`, indistinguishable   |

Client disconnect is **not** propagated to the body on either runtime, so a body
must be finite: an unbounded producer is not released when its client goes away.
Strata adds no timers and no abort signal for this. Do not stream where the
transport buffers if you need incremental delivery: the body is still delivered,
complete, and released, just not early.

## API boundary: 404, 405, HEAD and OPTIONS

By default `registerControllers()` only adds routes to Nitro's router, so a
request that matches none of them falls through to Analog's HTML renderer:
`GET /api/unknown` answers `200 text/html`, and so does an unsupported method on
a known path. The opt-in `apiBoundary` option makes selected path prefixes an
explicit API namespace with deterministic, safe answers:

```ts
import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [OrdersController], {
    apiBoundary: {
      prefixes: ["/api"],
      // Native Nitro routes under the prefix, declared for accurate 405 + Allow.
      nativeRoutes: [{ path: "/api/health", methods: ["GET"] }],
      head: "derive", // default
      options: "allow", // default: "off"
    },
  });
  // Later calls only add routes; the shared boundary already covers them.
  registerControllers(nitroApp.router, [ProductsController], { guards: [requireToken] });
});
```

A complete, compile-checked version (two controllers, a protected one, a native
route and the boundary) is
[`api-boundary-example.ts`](../../tests/full-stack-package-consumer/fixture/src/check/api-boundary-example.ts).

| Request                                                        | Answer                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Matches a Strata route and method                              | The route runs: guards, interceptors, factory, handler, cleanup                              |
| Matches a native Nitro route that handles the method           | Nitro serves it, untouched                                                                   |
| Below an owned prefix, matches nothing                         | `404`, `{"error":"not_found"}`, `application/json; charset=utf-8`, `Cache-Control: no-store` |
| Matches a Strata (or declared native) path, method not handled | `405`, `{"error":"method_not_allowed"}`, same headers plus `Allow`                           |
| Outside every owned prefix (pages, assets, `/_analog/fn/*`)    | Unchanged: Analog and Nitro decide                                                           |

**Ownership.** The boundary owns only the prefixes you list. A prefix is one or
more static segments (`/api`, `/internal/v1`); `/`, wildcards, parameters,
repeated separators and overlapping prefixes are configuration errors, so the
website itself can never be owned by accident. Internally it registers a
fallback for every method on `/<prefix>` and `/<prefix>/**`; Nitro's router
always prefers a more specific route that handles the request's method, so native
routes, Strata routes and Analog's own endpoints are never shadowed.

**404 versus an application 404.** The boundary's 404 means no route matched. A
matched handler that throws `StrataAnalogHttpError(404, "not_found")` produces
the same public body, but it did run its guards, interceptors and factory. A
path parameter is never treated as an unknown route:
`GET /api/products/not-a-route` reaches the `/:id` handler, which decides.

**Allow.** Derived only from registered route metadata (plus declared native
routes), in a stable order: `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`. If
several patterns match the path (a static route next to a `/:id` route) the set
is their union, which is also how Nitro falls through between them.
Undeclared native routes are unknown to the boundary: their wrong-method request
answers `404`, not `405` (declare them with `nativeRoutes` to get an accurate
`405`). A declared native route that already handles the method is always served
by Nitro.

**HEAD** (`head: "derive"`, default). `HEAD` on a path with a Strata `GET` route
runs that route's whole pipeline exactly once (guards, interceptors, factory,
handler, one cleanup) and returns its status and headers without a body. A
`Response` result's body is released without being read, so streams are not
consumed; a `streamResponse()` body is cancelled, which releases its resources. A denied `GET` is a denied `HEAD`. Handlers see `request.method ===
"HEAD"`. Plain returned values get the content type H3 would give them (JSON,
text); no `Content-Length` is synthesized. `HEAD` never maps to a mutating route.
It is not derived for native routes. `head: "off"` answers it like any other
unsupported method.

**OPTIONS** (`options: "allow"`, default `"off"`). A plain `OPTIONS` on a known
path returns `204` with `Allow` (including `OPTIONS`) and no body. A CORS
preflight (`Origin` plus `Access-Control-Request-Method`) is never answered by
Strata: it gets the `405` above without any `Access-Control-*` header, so the
browser blocks the cross-origin request. CORS, authentication and CSRF are not
part of routing: keep your CORS middleware, which runs before the router and
handles preflights itself. This also means an `OPTIONS` answer discloses the
supported methods of an owned path without authentication, exactly like a `405`;
leave `options` off if that matters.

**Guards and interceptors do not apply to framework answers.** A 404, a 405 and
an `OPTIONS` answer are produced before any route matched, so no guard,
interceptor or controller factory runs. Put request-wide policy (authentication
for the whole namespace, rate limiting) in Nitro middleware; a route-specific
guard is never pretended to apply to a route that did not match.

**Registration checks** (all before the router is touched): invalid or
overlapping prefixes, unknown option keys, invalid `nativeRoutes`, a policy
change for an already owned prefix, and every Strata route below an owned prefix
must use static and `:param` segments only, with unique parameter names and no
two routes of one method that differ only in parameter names (Nitro would serve
them from one entry). Routes outside owned prefixes keep every existing
behavior. The metadata is scoped to the router, so independent Nitro apps and
server lifetimes never share it.

**Known limits.** A native method-less catch-all that Nitro registers for
exactly `/<prefix>/**` is replaced by the fallback (use a method-specific file
such as `[...].get.ts`, which keeps priority). Path matching follows what the
router already decoded (`%34%32` is `42`, `%2F` stays encoded, one trailing `/`
is ignored, `//` never matches). Nitro's router does not backtrack out of a
static branch (`/a/new/x` against `/a/new/y` and `/a/:id/x`); the boundary then
serves the matching Strata route instead of contradicting its own route table.
Declaring Analog's own `/_analog` prefix is unsupported.

## Registration

- `registerControllers()` validates the whole batch (controllers, handlers,
  `controllerFactory`, route keys) before touching the router. If any check
  fails, it throws a `StrataAnalogConfigurationError` and registers nothing.
- Two Strata routes with the same HTTP method and final path (for example
  `GET /api/users`) on one router are a configuration error, whether they come
  from one controller, two controllers or two calls.
- Repeated calls on one router are supported for non-overlapping routes, and
  the same controllers can be registered on different routers.
- Duplicate detection covers Strata registrations on the same router only; it
  does not see native Analog/Nitro routes (declare them in
  `apiBoundary.nativeRoutes` when you want accurate 405 answers).
- Registration is atomic with respect to Strata configuration validation. It is
  not transactional against failures thrown by the external router while
  committing routes: that error propagates, and routes the router already
  accepted cannot be rolled back.

**Pre-1.0 and experimental.** `0.x` releases may contain breaking changes in any
minor. Release candidates are published on the `next` dist-tag. ESM only,
Node.js >= 22.

See the [repository README](https://github.com/Andersseen/Strata#readme) for
documentation. License: MIT.
