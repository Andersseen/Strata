import { H3 } from "h3";

import { Controller, Get, getControllerDefinition } from "@strata-sc/core";
import { registerControllers } from "@strata-sc/h3";

@Controller("/consumer")
class ConsumerController {
  private readonly greeting = "hello";

  @Get()
  root(): { greeting: string } {
    return { greeting: this.greeting };
  }

  @Get("/async")
  async asyncRoute(): Promise<{ greeting: string; async: true }> {
    return { greeting: this.greeting, async: true };
  }
}

const definition = getControllerDefinition(ConsumerController);

if (!definition) {
  throw new Error("Expected ConsumerController to carry Strata metadata.");
}

console.log("DEFINITION_JSON_START");
console.log(JSON.stringify(definition));
console.log("DEFINITION_JSON_END");

const app = new H3();

app.get("/native", () => ({ native: true }));

registerControllers(app, [ConsumerController]);

async function main(): Promise<void> {
  const rootResponse = await app.request(new Request("http://localhost/consumer"));
  const asyncResponse = await app.request(new Request("http://localhost/consumer/async"));
  const nativeResponse = await app.request(new Request("http://localhost/native"));

  console.log("ROOT_STATUS", rootResponse.status);
  console.log("ROOT_BODY", await rootResponse.text());
  console.log("ASYNC_STATUS", asyncResponse.status);
  console.log("ASYNC_BODY", await asyncResponse.text());
  console.log("NATIVE_STATUS", nativeResponse.status);
  console.log("NATIVE_BODY", await nativeResponse.text());
}

void main();
