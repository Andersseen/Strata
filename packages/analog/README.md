# @strata/analog

Experimental [Analog](https://analogjs.org) 2 adapter for
[Strata](https://github.com/Andersseen/Strata): registers `@strata/core`
controllers on the Nitro router from a Nitro server plugin. It does not depend
on `h3`, `nitropack` or `@analogjs/*`, and its declarations do not expose
H3/Nitro types.

```bash
pnpm add @strata/core@next @strata/analog@next
```

```ts
// src/server/strata/posts.controller.ts
import { Controller, Get } from "@strata/core";
import type { StrataAnalogRequest } from "@strata/analog";

@Controller("/api/posts")
export class PostsController {
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    return { id: request.params["id"] };
  }
}
```

```ts
// src/server/plugins/strata.ts
import { registerControllers } from "@strata/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { PostsController } from "../strata/posts.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [PostsController]);
});
```

Controllers are request-scoped. An optional `controllerFactory` (sync or async)
creates each request's controller and can register `onCleanup` callbacks that
run after the invocation settles.

**Pre-1.0 and experimental.** `0.x` releases are published under the `next`
dist-tag and may contain breaking changes. ESM only, Node.js >= 22.

See the [repository README](https://github.com/Andersseen/Strata#readme) for
documentation. License: MIT.
