export const CONTROLLER_EXAMPLE = `import { Controller, Get } from "@strata-sc/core";

@Controller("/users")
export class UsersController {
  @Get()
  findAll() {
    return [{ id: "1", name: "Ada" }];
  }
}`;

export const ANALOG_EXAMPLE = `import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";
import { UsersController } from "../strata/users.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [UsersController]);
});`;
