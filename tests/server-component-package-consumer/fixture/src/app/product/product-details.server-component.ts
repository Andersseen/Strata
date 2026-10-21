import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import { ProductPickerComponent } from "@strata-test/angular-widgets";
import type { ProductView as PackageProductView } from "@strata-test/angular-widgets";

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
  imports: [
    AddToCartComponent,
    ProductPickerComponent,
    LegacyCounterComponent,
    StrataClientBoundary,
  ],
  template: `<article [attr.data-evidence]="evidence">
    <h1>{{ product.name }}</h1>
    <p id="server-message">External server A</p>
    <add-to-cart [product]="publicProduct" [strataClient]="{ product: publicProduct }" />
    <acme-product-picker
      id="package-picker-primary"
      [productView]="publicProduct"
      [strataClient]="{ productView: publicProduct }"
    />
    <acme-product-picker
      id="package-picker-alternate"
      [productView]="alternateProduct"
      [strataClient]="{ productView: alternateProduct }"
    />
    <legacy-counter [start]="0" [strataClient]="{ start: 0 }" />
  </article>`,
})
export class ProductDetailsServerComponent {
  private readonly products = inject(ProductRepository);

  protected readonly product = this.products.findById("42");
  protected readonly publicProduct: ProductView & PackageProductView = {
    id: this.product.id,
    name: this.product.name,
    variants: this.product.variants.map(({ id, label, stock }) => ({ id, label, stock })),
  };
  protected readonly alternateProduct: ProductView & PackageProductView = {
    ...this.publicProduct,
    name: "Product 42 alternate",
    variants: this.publicProduct.variants.map((variant) => ({
      ...variant,
      stock: variant.stock + 100,
    })),
  };
  protected readonly evidence = `${fingerprint(IMPLEMENTATION_MARKER)}.${this.product.provenance}`;
}
