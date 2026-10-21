import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { AddToCartComponent } from "./add-to-cart.component";
import type { ProductView } from "./add-to-cart.component";
import { ProductRepository } from "./product.repository";
import { LegacyCounterComponent } from "./legacy-counter.component";
import { fingerprint } from "./server-helper";

// Emitted only by this server component's implementation.
const IMPLEMENTATION_MARKER = "EXTERNAL_CONSUMER_IMPLEMENTATION_MARKER";

@ServerComponent()
@Component({
  selector: "product-details",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AddToCartComponent, LegacyCounterComponent, StrataClientBoundary],
  template: `<article [attr.data-evidence]="evidence">
    <h1>{{ product.name }}</h1>
    <p id="server-message">External server A</p>
    <add-to-cart [product]="publicProduct" [strataClient]="{ product: publicProduct }" />
    <legacy-counter [start]="0" [strataClient]="{ start: 0 }" />
  </article>`,
})
export class ProductDetailsServerComponent {
  private readonly products = inject(ProductRepository);

  protected readonly product = this.products.findById("42");
  protected readonly publicProduct: ProductView = {
    id: this.product.id,
    name: this.product.name,
    variants: this.product.variants.map(({ id, label, stock }) => ({ id, label, stock })),
  };
  protected readonly evidence = `${fingerprint(IMPLEMENTATION_MARKER)}.${this.product.provenance}`;
}
