export const SERVER_COMPONENT_EXAMPLE = `import { Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { AddToCartComponent } from "./add-to-cart.component";
import { ProductRepository } from "./product.repository";

@ServerComponent()
@Component({
  selector: "product-summary",
  imports: [AddToCartComponent, StrataClientBoundary],
  template: \`
    <h1>{{ product.name }}</h1>
    <p>{{ product.description }}</p>

    <add-to-cart
      [productId]="product.id"
      [strataClient]="{ productId: product.id }"
    />
  \`,
})
export class ProductSummary {
  // Server-only: neither this class nor ProductRepository
  // ever enters the browser bundle.
  private readonly products = inject(ProductRepository);

  protected readonly product = this.products.findById("42");
}`;

export const CLIENT_BOUNDARY_EXAMPLE = `import { Component, input, signal } from "@angular/core";

// An ordinary Angular component. Marked with [strataClient]
// by its server parent, it is the only part that hydrates.
@Component({
  selector: "add-to-cart",
  template: \`
    <button type="button" (click)="add()">Add to cart</button>
    <output>{{ count() }}</output>
  \`,
})
export class AddToCartComponent {
  readonly productId = input.required<string>();
  readonly count = signal(0);

  add() {
    this.count.update((count) => count + 1);
  }
}`;

export const CONTROLLER_EXAMPLE = `import { Controller, Delete, Get, Patch, Post, Put } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

@Controller("/api/users")
export class UsersController {
  @Get()
  list() {
    return [{ id: "1", name: "Ada" }];
  }

  @Post()
  async create(request: StrataAnalogRequest) {
    return request.readJson<{ name: string }>();
  }

  @Put("/:id")
  async replace(request: StrataAnalogRequest) {
    return { id: request.params["id"], ...(await request.readJson<{ name: string }>()) };
  }

  @Patch("/:id")
  async rename(request: StrataAnalogRequest) {
    const { name } = await request.readJson<{ name: string }>();
    return { id: request.params["id"], name };
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    return { deleted: request.params["id"] };
  }
}`;

export const ANALOG_EXAMPLE = `import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";
import { UsersController } from "../strata/users.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [UsersController]);
});`;

export const METADATA_EXAMPLE = `import { getControllerDefinition } from "@strata-sc/core";
import { UsersController } from "./users.controller";

getControllerDefinition(UsersController);
// {
//   path: "/api/users",
//   routes: [
//     { method: "GET", path: "/", handler: "list" },
//     { method: "POST", path: "/", handler: "create" },
//     { method: "PUT", path: "/:id", handler: "replace" },
//     { method: "PATCH", path: "/:id", handler: "rename" },
//     { method: "DELETE", path: "/:id", handler: "remove" },
//   ],
// }`;
