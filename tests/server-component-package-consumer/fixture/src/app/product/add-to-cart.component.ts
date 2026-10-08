import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

// Emitted by the client island. It must reach the browser output.
const CLIENT_MARKER = "EXTERNAL_CONSUMER_CLIENT_MARKER";

@Component({
  selector: "add-to-cart",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
      type="button"
      [attr.data-product-id]="productId()"
      [attr.data-marker]="marker"
      (click)="add()"
    >
      Add to cart
    </button>
    <output>Count: {{ count() }}</output>`,
})
export class AddToCartComponent {
  readonly productId = input.required<string>();

  protected readonly count = signal(0);
  protected readonly marker = CLIENT_MARKER;

  protected add(): void {
    this.count.update((count) => count + 1);
  }
}
