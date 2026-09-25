# @strata/core

Experimental `@Controller` / `@Get` metadata primitive for
[Strata](https://github.com/Andersseen/Strata). It uses standard ECMAScript
decorators (no `experimentalDecorators`, no `reflect-metadata`) and has no
HTTP runtime of its own; pair it with an adapter such as `@strata/analog`.

```bash
pnpm add @strata/core@next
```

```ts
import { Controller, Get, getControllerDefinition } from "@strata/core";

@Controller("/api/posts")
class PostsController {
  @Get("/:id")
  findOne() {}
}

getControllerDefinition(PostsController);
// { path: "/api/posts", routes: [{ method: "GET", path: "/:id", handler: "findOne" }] }
```

**Pre-1.0 and experimental.** `0.x` releases are published under the `next`
dist-tag and may contain breaking changes. ESM only, Node.js >= 22.

See the [repository README](https://github.com/Andersseen/Strata#readme) for
documentation. License: MIT.
