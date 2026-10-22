import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

// Emitted by the client island. It must reach the browser output.
const CLIENT_MARKER = "FULLSTACK_CONSUMER_CLIENT_MARKER";

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
    <output>{{ status() }}</output>
    <button type="button" data-api-probe [disabled]="loading()" (click)="probeApi()">
      Probe API routing
    </button>
    <p data-api-probe-result>{{ apiProbe() }}</p>`,
})
export class ProductAvailabilityComponent {
  readonly productId = input.required<string>();

  protected readonly marker = CLIENT_MARKER;
  protected readonly status = signal("Availability: not checked");
  protected readonly loading = signal(false);
  protected readonly apiProbe = signal("API: not probed");

  /**
   * Calls the public API the way an application would and reports what came back,
   * so the browser can observe that every answer is JSON, never an HTML document.
   */
  protected async probeApi(): Promise<void> {
    this.loading.set(true);

    try {
      const id = encodeURIComponent(this.productId());
      const found = await fetch(`/api/products/${id}`);
      const missing = await fetch(`/api/products/${id}/unknown-route`);
      const unsupported = await fetch(`/api/products/${id}`, { method: "PUT" });
      const describe = async (response: Response): Promise<string> => {
        const type = response.headers.get("content-type") ?? "none";
        const body = await response.text();

        return `${response.status} ${type.startsWith("application/json") ? "json" : "NOT-JSON"} ${body.startsWith("<") ? "html" : "data"}`;
      };

      this.apiProbe.set(
        `API: found=${await describe(found)}; missing=${await describe(missing)}; ` +
          `unsupported=${await describe(unsupported)} allow=${unsupported.headers.get("allow") ?? "none"}`,
      );
    } catch {
      this.apiProbe.set("API: network error");
    } finally {
      this.loading.set(false);
    }
  }

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
