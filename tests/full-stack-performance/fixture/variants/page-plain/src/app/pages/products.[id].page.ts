import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { ProductDetailsComponent } from "../products/product-details.component";

@Component({
  selector: "app-product-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsComponent],
  template: `<main>
      <product-details [productId]="id" />
    </main>
    <nav><a id="to-about" href="/about">About (document link)</a></nav>`,
})
export default class ProductPage {
  protected readonly id = inject(ActivatedRoute).snapshot.paramMap.get("id") ?? "";
}
