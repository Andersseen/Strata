import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { AddToCartComponent } from "./add-to-cart.component";
import { ProductRepository, fingerprint } from "./product-repository";
import { ServerPricePipe } from "./server-price.pipe";

// Emitted only by this server component's implementation.
const IMPLEMENTATION_MARKER = "STRATA_SERVER_COMPONENT_IMPLEMENTATION_MARKER";

/**
 * The server component under test. The @strata-sc/server-components/vite plugin
 * replaces this module in the browser graph with a generated surrogate, so
 * neither this class nor ProductRepository (nor what that imports) ships.
 * Only AddToCart, the element marked [strataClient], is a client reference:
 * ServerPricePipe is imported too, but stays server-only.
 */
@ServerComponent()
@Component({
  selector: "product-details",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AddToCartComponent, ServerPricePipe, StrataClientBoundary],
  template: `<article [attr.data-evidence]="evidence" [attr.data-price]="product.id | serverPrice">
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
