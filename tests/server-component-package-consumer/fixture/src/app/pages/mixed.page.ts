import { ChangeDetectionStrategy, Component } from "@angular/core";

import { ProductDetailsServerComponent } from "../product/product-details.server-component";
import { StockPanelServerComponent } from "../product/stock-panel.server-component";

// Two different Server Components, each with its own installed package islands, in one document:
// the installed-island qualification refuses one and requires the other to stay interactive.
@Component({
  selector: "app-mixed-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsServerComponent, StockPanelServerComponent],
  template: `<main>
    <product-details />
    <stock-panel />
  </main>`,
})
export default class MixedPage {}
