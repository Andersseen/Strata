import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import { StockBadgeComponent } from "@strata-test/angular-widgets/second";

// A second Server Component hosting a second, independent installed package component. It shares no
// reference registry with `product-details`, so a refused host there must leave this one untouched.
@ServerComponent()
@Component({
  selector: "stock-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StockBadgeComponent, StrataClientBoundary],
  template: `<section data-stock-panel>
    <h2>Stock panel</h2>
    <acme-stock-badge
      [label]="label"
      [stockQuantity]="quantity"
      [strataClient]="{ label: label, stockQuantity: quantity }"
    />
  </section>`,
})
export class StockPanelServerComponent {
  protected readonly label = "Units";
  protected readonly quantity = 7;
}
