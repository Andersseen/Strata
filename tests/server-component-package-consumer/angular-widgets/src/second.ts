import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";

/** A second, independent installed island: different selector, different input shape. */
@Component({
  selector: "acme-stock-badge",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" data-package-badge (click)="bump()">
    {{ label() }}: {{ quantity() + bumps() }}
  </button>`,
})
export class StockBadgeComponent {
  readonly label = input.required<string>();
  readonly quantity = input.required<number>({ alias: "stockQuantity" });
  protected readonly bumps = signal(0);
  protected readonly doubled = computed(() => this.quantity() * 2);

  protected bump(): void {
    this.bumps.update((count) => count + 1);
  }
}
