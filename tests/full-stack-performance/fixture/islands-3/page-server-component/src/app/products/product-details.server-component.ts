import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { FulfilmentRepository } from "./fulfilment.repository";
import { fingerprint } from "./server-helper";
import { ProductAvailabilityComponent } from "./product-availability.component";
import { ProductDeliveryComponent } from "./product-delivery.component";
import { ProductRepository } from "./product.repository";
import { ProductStockComponent } from "./product-stock.component";

const IMPLEMENTATION_MARKER = "PERF_CONSUMER_IMPLEMENTATION_MARKER";

@ServerComponent()
@Component({
  selector: "product-details",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ProductAvailabilityComponent,
    ProductStockComponent,
    ProductDeliveryComponent,
    StrataClientBoundary,
  ],
  template: `@if (product(); as product) {
      <article [attr.data-evidence]="evidence()" [attr.data-fulfilment]="fulfilmentEvidence()">
        <h1>{{ product.name }}</h1>
        <p id="server-tier">Tier: {{ product.tier }}</p>
        <p id="ship-from">Ships from: {{ region() }}</p>
        <product-availability [productId]="product.id" [strataClient]="{ productId: product.id }" />
        <product-stock [productId]="product.id" [strataClient]="{ productId: product.id }" />
        <product-delivery
          [productId]="product.id"
          [region]="region()"
          [strataClient]="{ productId: product.id, region: region() }"
        />
      </article>
    } @else {
      <p id="not-found">Product not found</p>
    }`,
})
export class ProductDetailsServerComponent {
  private readonly products = inject(ProductRepository);
  private readonly fulfilment = inject(FulfilmentRepository);

  readonly productId = input.required<string>();

  protected readonly product = computed(() => this.products.findById(this.productId()));
  protected readonly region = computed(
    () => this.fulfilment.findById(this.productId())?.region ?? "unknown",
  );
  protected readonly evidence = computed(
    () => `${fingerprint(IMPLEMENTATION_MARKER)}.${this.product()?.provenance ?? "none"}`,
  );
  protected readonly fulfilmentEvidence = computed(
    () => this.fulfilment.findById(this.productId())?.provenance ?? "none",
  );
}
