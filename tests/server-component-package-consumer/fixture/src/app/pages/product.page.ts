import { ChangeDetectionStrategy, Component } from "@angular/core";

import { ProductDetailsServerComponent } from "../product/product-details.server-component";

@Component({
  selector: "app-product-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsServerComponent],
  template: `<main>
      <product-details />
    </main>
    <nav><a id="to-about" href="/about">About (document link)</a></nav>`,
})
export default class ProductPage {}
