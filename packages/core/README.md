# @strata-sc/core

Experimental `@Controller` and HTTP route decorator metadata primitives for
[Strata](https://github.com/Andersseen/Strata). It uses standard ECMAScript
decorators (no `experimentalDecorators`, no `reflect-metadata`) and has no
HTTP runtime of its own; pair it with an adapter such as `@strata-sc/analog`.

```bash
pnpm add @strata-sc/core@next
```

```ts
import {
  Controller,
  Delete,
  Get,
  getControllerDefinition,
  Patch,
  Post,
  Put,
} from "@strata-sc/core";

@Controller("/api/posts")
class PostsController {
  @Get()
  list() {}

  @Post()
  create() {}

  @Put("/:id")
  replace() {}

  @Patch("/:id")
  update() {}

  @Delete("/:id")
  remove() {}
}

getControllerDefinition(PostsController);
// {
//   path: "/api/posts",
//   routes: [
//     { method: "GET", path: "/", handler: "list" },
//     { method: "POST", path: "/", handler: "create" },
//     { method: "PUT", path: "/:id", handler: "replace" },
//     { method: "PATCH", path: "/:id", handler: "update" },
//     { method: "DELETE", path: "/:id", handler: "remove" },
//   ],
// }
```

`Get`, `Post`, `Put`, `Patch` and `Delete` share one contract: routes are
recorded in declaration order, paths are normalized the same way, and each
accepts public or protected instance methods with a string name; static,
private (`#name`) and symbol-named methods throw a `TypeError` when the class
is defined. `HEAD`, `OPTIONS` and other methods have no decorator yet.

Controller metadata is class-local. Extending a controller does not implicitly
inherit `@Controller()` or route decorators. Decorate the subclass and its
routes explicitly.

**Pre-1.0 and experimental.** `0.x` releases are published under the `next`
dist-tag and may contain breaking changes. ESM only, Node.js >= 22.

See the [repository README](https://github.com/Andersseen/Strata#readme) for
documentation. License: MIT.
