import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";

import { fingerprint } from "./server-helper";
import { ProductAvailabilityComponent } from "./product-availability.component";
import { ProductRepository } from "./product.repository";

const IMPLEMENTATION_MARKER = "PERF_CONSUMER_IMPLEMENTATION_MARKER";

@Component({
  selector: "product-details",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductAvailabilityComponent],
  template: `@if (product(); as product) {
      <article [attr.data-evidence]="evidence()">
        <h1>{{ product.name }}</h1>
        <p id="server-tier">Tier: {{ product.tier }}</p>
        <product-availability [productId]="product.id" />
      </article>
    } @else {
      <p id="not-found">Product not found</p>
    }`,
})
export class ProductDetailsComponent {
  private readonly products = inject(ProductRepository);

  readonly productId = input.required<string>();

  protected readonly product = computed(() => this.products.findById(this.productId()));
  protected readonly evidence = computed(
    () => `${fingerprint(IMPLEMENTATION_MARKER)}.${this.product()?.provenance ?? "none"}`,
  );
}
