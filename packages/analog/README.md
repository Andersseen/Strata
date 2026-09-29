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

@Controller("/api/posts")
export class PostsController {
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    return { id: request.params["id"] };
  }

  @Post()
  async create(request: StrataAnalogRequest) {
    return request.readJson();
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
import { defineNitroPlugin } from "nitropack/runtime";

import { PostsController } from "../strata/posts.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [PostsController]);
});
```

Every `@strata-sc/core` HTTP decorator (`Get`, `Post`, `Put`, `Patch`,
`Delete`) is registered for its own method on the Nitro router, and all of them
run through the same request-scoped invocation. Handlers receive a
`StrataAnalogRequest` with `method`, params, query, headers and lazy body
readers (`readJson()`, `readText()`, `readBody()`).

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

**Pre-1.0 and experimental.** `0.x` releases are published under the `next`
dist-tag and may contain breaking changes. ESM only, Node.js >= 22.

See the [repository README](https://github.com/Andersseen/Strata#readme) for
documentation. License: MIT.
