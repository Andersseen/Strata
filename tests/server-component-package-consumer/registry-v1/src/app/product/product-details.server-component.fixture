import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { AddToCartComponent } from "./add-to-cart.component";
import { ProductRepository } from "./product.repository";
import { fingerprint } from "./server-helper";

// Emitted only by this server component's implementation.
const IMPLEMENTATION_MARKER = "EXTERNAL_CONSUMER_IMPLEMENTATION_MARKER";

@ServerComponent()
@Component({
  selector: "product-details",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AddToCartComponent, StrataClientBoundary],
  template: `<article [attr.data-evidence]="evidence">
    <h1>{{ product.name }}</h1>
    <p id="server-message">External server A</p>
    <add-to-cart [productId]="product.id" [strataClient]="{ productId: product.id }" />
  </article>`,
})
export class ProductDetailsServerComponent {
  private readonly products = inject(ProductRepository);

  protected readonly product = this.products.findById("42");
  protected readonly evidence = `${fingerprint(IMPLEMENTATION_MARKER)}.${this.product.provenance}`;
}
