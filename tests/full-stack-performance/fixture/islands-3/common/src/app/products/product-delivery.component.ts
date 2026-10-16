import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

// Emitted by the third client island. It must reach the browser output.
const DELIVERY_CLIENT_MARKER = "PERF_DELIVERY_CLIENT_MARKER";

interface PublicDelivery {
  readonly id: string;
  readonly days: number;
}

/**
 * Island three: a third independent component. Besides the product id it receives one
 * explicitly public prop, the destination region the server chose for the page.
 */
@Component({
  selector: "product-delivery",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
      type="button"
      [attr.data-product-id]="productId()"
      [attr.data-region]="region()"
      [attr.data-marker]="marker"
      [disabled]="loading()"
      (click)="estimate()"
    >
      Estimate delivery to {{ region() }}
    </button>
    <output>{{ status() }}</output>`,
})
export class ProductDeliveryComponent {
  readonly productId = input.required<string>();
  readonly region = input.required<string>();

  protected readonly marker = DELIVERY_CLIENT_MARKER;
  protected readonly status = signal("Delivery: not estimated");
  protected readonly loading = signal(false);

  protected async estimate(): Promise<void> {
    this.loading.set(true);

    try {
      const response = await fetch(
        `/api/products/${encodeURIComponent(this.productId())}/delivery`,
      );

      if (!response.ok) {
        this.status.set(`Delivery: error ${response.status}`);

        return;
      }

      const delivery = (await response.json()) as PublicDelivery;

      this.status.set(`Delivery: ${delivery.days} days`);
    } catch {
      this.status.set("Delivery: network error");
    } finally {
      this.loading.set(false);
    }
  }
}
