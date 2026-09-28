# @strata-sc/core

Experimental `@Controller` / `@Get` metadata primitive for
[Strata](https://github.com/Andersseen/Strata). It uses standard ECMAScript
decorators (no `experimentalDecorators`, no `reflect-metadata`) and has no
HTTP runtime of its own; pair it with an adapter such as `@strata-sc/analog`.

```bash
pnpm add @strata-sc/core@next
```

```ts
import { Controller, Get, getControllerDefinition } from "@strata-sc/core";

@Controller("/api/posts")
class PostsController {
  @Get("/:id")
  findOne() {}
}

getControllerDefinition(PostsController);
// { path: "/api/posts", routes: [{ method: "GET", path: "/:id", handler: "findOne" }] }
```

Controller metadata is class-local. Extending a controller does not implicitly
inherit `@Controller()` or route decorators. Decorate the subclass and its
routes explicitly. `@Get()` accepts public or protected instance methods with a
string name; static, private (`#name`) and symbol-named methods throw a
`TypeError` when the class is defined.

**Pre-1.0 and experimental.** `0.x` releases are published under the `next`
dist-tag and may contain breaking changes. ESM only, Node.js >= 22.

See the [repository README](https://github.com/Andersseen/Strata#readme) for
documentation. License: MIT.
