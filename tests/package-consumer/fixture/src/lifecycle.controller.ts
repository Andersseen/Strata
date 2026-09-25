import { Controller, Get } from "@strata/core";

import type { StrataAnalogRequest } from "@strata/analog";

let constructed = 0;

export function constructedControllers(): number {
  return constructed;
}

@Controller("/api/lifecycle")
export class LifecycleController {
  readonly instance = ++constructed;
  #slug: string | undefined;

  @Get("/:slug")
  async show(request: StrataAnalogRequest) {
    // Instance state written before and read after an await: with a shared
    // controller, concurrent requests would overwrite each other's slug.
    this.#slug = request.params["slug"];
    const delay = request.query["delay"];

    await new Promise((resolve) =>
      setTimeout(resolve, typeof delay === "string" ? Number(delay) : 0),
    );

    return { slug: this.#slug, instance: this.instance };
  }
}

@Controller("/api/failing")
export class FailingController {
  @Get()
  explode(): never {
    throw new Error("handler failure");
  }
}
