import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

// Emitted by the client island. It must reach the browser output.
const CLIENT_MARKER = "PERF_CONSUMER_CLIENT_MARKER";

interface PublicProduct {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
}

/**
 * The client island. It reaches the controller only through an explicit public
 * HTTP request: it imports neither the controller nor any server-only code, and
 * shares no Angular injector with the server.
 */
@Component({
  selector: "product-availability",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
      type="button"
      [attr.data-product-id]="productId()"
      [attr.data-marker]="marker"
      [disabled]="loading()"
      (click)="refresh()"
    >
      Refresh availability
    </button>
    <output>{{ status() }}</output>`,
})
export class ProductAvailabilityComponent {
  readonly productId = input.required<string>();

  protected readonly marker = CLIENT_MARKER;
  protected readonly status = signal("Availability: not checked");
  protected readonly loading = signal(false);

  protected async refresh(): Promise<void> {
    this.loading.set(true);

    try {
      const response = await fetch(`/api/products/${encodeURIComponent(this.productId())}`);

      if (!response.ok) {
        this.status.set(`Availability: error ${response.status}`);

        return;
      }

      const product = (await response.json()) as PublicProduct;

      this.status.set(`Availability: ${product.available ? "available" : "unavailable"}`);
    } catch {
      this.status.set("Availability: network error");
    } finally {
      this.loading.set(false);
    }
  }
}
