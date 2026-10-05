import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

import { formatShared } from "./shared-format";

// Emitted by the interactive child. It must reach the browser output.
const CLIENT_COMPONENT_MARKER = "STRATA_CLIENT_COMPONENT_MARKER";

/** An ordinary interactive standalone component, rendered inside a server component. */
@Component({
  selector: "add-to-cart",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
      type="button"
      [attr.data-product-id]="productId()"
      [attr.data-marker]="marker"
      [attr.data-shared]="shared"
      (click)="add()"
    >
      Add to cart
    </button>
    <output>Count: {{ count() }}</output>`,
})
export class AddToCartComponent {
  readonly productId = input.required<string>();

  protected readonly count = signal(0);
  protected readonly marker = CLIENT_COMPONENT_MARKER;
  // Also imported by the server-only ProductRepository: shared, not server-only.
  protected readonly shared = formatShared("add-to-cart");

  protected add(): void {
    this.count.update((count) => count + 1);
  }
}
