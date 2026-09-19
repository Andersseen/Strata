import { getControllerDefinition } from "@strata/core";
import { defineEventHandler } from "h3";

import { HelloController } from "../../strata/hello.controller";

export default defineEventHandler(() => {
  const definition = getControllerDefinition(HelloController);

  return {
    source: "strata-core",
    definition,
    invoked: new HelloController().hello(),
  };
});
