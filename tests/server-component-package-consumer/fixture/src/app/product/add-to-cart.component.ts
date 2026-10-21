import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";

export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly variants: readonly {
    readonly id: string;
    readonly label: string;
    readonly stock: number;
  }[];
}

// Emitted by the client island. It must reach the browser output.
const CLIENT_MARKER = "EXTERNAL_CONSUMER_CLIENT_MARKER";

@Component({
  selector: "add-to-cart",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
      type="button"
      [attr.data-product-id]="product().id"
      [attr.data-marker]="marker"
      (click)="add()"
    >
      Add to cart
    </button>
    <div role="group" aria-label="Product variants">
      @for (variant of product().variants; track variant.id) {
        <button
          type="button"
          [attr.data-variant]="variant.id"
          [attr.aria-pressed]="selectedVariantId() === variant.id"
          (click)="selectedVariantId.set(variant.id)"
        >
          {{ variant.label }}
        </button>
      }
    </div>
    <output id="stock" aria-live="polite">In stock: {{ selectedVariant()?.stock }}</output>
    <output>Count: {{ count() }}</output>`,
})
export class AddToCartComponent {
  readonly product = input.required<ProductView>();

  protected readonly count = signal(0);
  protected readonly selectedVariantId = signal("black");
  protected readonly selectedVariant = computed(
    () =>
      this.product().variants.find((variant) => variant.id === this.selectedVariantId()) ??
      this.product().variants[0],
  );
  protected readonly marker = CLIENT_MARKER;

  protected add(): void {
    this.count.update((count) => count + 1);
  }
}
