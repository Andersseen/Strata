import { ChangeDetectionStrategy, Component } from "@angular/core";

import { ProductDetailsServerComponent } from "../products/product-details.server-component";

// Two Server Component hosts in one document: the upgrade/rollback qualification replaces one of
// them with the other release's rendering to prove a healthy sibling stays independent.
@Component({
  selector: "app-pair-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsServerComponent],
  template: `<main>
    <product-details productId="42" />
    <product-details productId="42" />
  </main>`,
})
export default class PairPage {}
