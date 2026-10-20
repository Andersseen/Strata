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
validation issues. Production tracing, cancellation and full response-stream
lifecycle are not qualified.

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
run after the invocation settles.

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
  does not see native Analog/Nitro routes.
- Registration is atomic with respect to Strata configuration validation. It is
  not transactional against failures thrown by the external router while
  committing routes: that error propagates, and routes the router already
  accepted cannot be rolled back.

**Pre-1.0 and experimental.** `0.x` releases may contain breaking changes in any
minor. Release candidates are published on the `next` dist-tag. ESM only,
Node.js >= 22.

See the [repository README](https://github.com/Andersseen/Strata#readme) for
documentation. License: MIT.
