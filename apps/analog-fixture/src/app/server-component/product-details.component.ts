import { ChangeDetectionStrategy, Component, inject } from "@angular/core";

import { ServerComponent } from "../../server-components/server-component";
import { StrataClientBoundary } from "../../server-components/client-boundary.directive";

import { AddToCartComponent } from "./add-to-cart.component";
import { ProductRepository, fingerprint } from "./product-repository";

// Emitted only by this server component's implementation.
const IMPLEMENTATION_MARKER = "STRATA_SERVER_COMPONENT_IMPLEMENTATION_MARKER";

/**
 * The server component under test. The fixture's server-components plugin
 * replaces this module in the browser graph with a generated surrogate, so
 * neither this class nor ProductRepository (nor what that imports) ships.
 */
@ServerComponent()
@Component({
  selector: "product-details",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AddToCartComponent, StrataClientBoundary],
  template: `<article [attr.data-evidence]="evidence">
    <h1>{{ product.name }}</h1>
    <p>{{ product.description }}</p>
    <add-to-cart [productId]="product.id" [strataClient]="{ productId: product.id }" />
  </article>`,
})
export class ProductDetailsComponent {
  private readonly products = inject(ProductRepository);

  protected readonly product = this.products.findById("42");
  protected readonly evidence = `${fingerprint(IMPLEMENTATION_MARKER)}.${this.product.provenance}`;
}
