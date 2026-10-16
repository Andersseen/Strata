import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { ProductDetailsServerComponent } from "../products/product-details.server-component";

@Component({
  selector: "app-product-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsServerComponent],
  template: `<main>
      <product-details [productId]="id" />
    </main>
    <nav><a id="to-about" href="/about">About (document link)</a></nav>`,
})
export default class ProductPage {
  protected readonly id = inject(ActivatedRoute).snapshot.paramMap.get("id") ?? "";
}
