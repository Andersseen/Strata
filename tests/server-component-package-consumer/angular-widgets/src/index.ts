import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";

const PACKAGE_CLIENT_MARKER = "STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT";

export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly variants: readonly {
    readonly id: string;
    readonly label: string;
    readonly stock: number;
  }[];
}

@Component({
  selector: "acme-product-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section aria-label="{{ product().name }} options" [attr.data-package-marker]="marker">
    <h2>{{ product().name }}</h2>
    <div role="group" aria-label="Choose a variant">
      @for (variant of product().variants; track variant.id) {
        <button
          type="button"
          [attr.data-package-variant]="variant.id"
          [attr.aria-pressed]="selectedVariantId() === variant.id"
          (click)="select(variant.id)"
        >
          {{ variant.label }}
        </button>
      }
    </div>
    <output data-package-stock aria-live="polite">Stock: {{ selectedVariant().stock }}</output>
    <output data-package-events>{{ eventCount() }}</output>
  </section>`,
})
export class ProductPickerComponent {
  readonly product = input.required<ProductView>({ alias: "productView" });
  protected readonly selectedVariantId = signal("black");
  protected readonly eventCount = signal(0);
  protected readonly marker = PACKAGE_CLIENT_MARKER;
  protected readonly selectedVariant = computed(
    () =>
      this.product().variants.find((variant) => variant.id === this.selectedVariantId()) ??
      this.product().variants[0],
  );

  protected select(id: string): void {
    this.selectedVariantId.set(id);
    this.eventCount.update((count) => count + 1);
  }
}
