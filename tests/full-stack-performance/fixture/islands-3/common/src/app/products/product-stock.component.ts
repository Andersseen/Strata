import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

// Emitted by the second client island. It must reach the browser output.
const STOCK_CLIENT_MARKER = "PERF_STOCK_CLIENT_MARKER";

interface PublicStock {
  readonly id: string;
  readonly units: number;
}

/**
 * Island two: an independent component with its own state and its own public request.
 * It imports neither a controller nor any server-only code.
 */
@Component({
  selector: "product-stock",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
      type="button"
      [attr.data-product-id]="productId()"
      [attr.data-marker]="marker"
      [disabled]="loading()"
      (click)="refresh()"
    >
      Check stock
    </button>
    <output>{{ status() }}</output>`,
})
export class ProductStockComponent {
  readonly productId = input.required<string>();

  protected readonly marker = STOCK_CLIENT_MARKER;
  protected readonly status = signal("Stock: not checked");
  protected readonly loading = signal(false);

  protected async refresh(): Promise<void> {
    this.loading.set(true);

    try {
      const response = await fetch(`/api/products/${encodeURIComponent(this.productId())}/stock`);

      if (!response.ok) {
        this.status.set(`Stock: error ${response.status}`);

        return;
      }

      const stock = (await response.json()) as PublicStock;

      this.status.set(`Stock: ${stock.units} units`);
    } catch {
      this.status.set("Stock: network error");
    } finally {
      this.loading.set(false);
    }
  }
}
