import { ChangeDetectionStrategy, Component } from "@angular/core";

import { ProductDetailsServerComponent } from "../product/product-details.server-component";

// Two hosts of the same Server Component in one document: identical selectors and props, so the
// deployment-skew qualification can tell hosts apart only by their element identity.
@Component({
  selector: "app-pair-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsServerComponent],
  template: `<main>
    <product-details />
    <product-details />
  </main>`,
})
export default class PairPage {}
