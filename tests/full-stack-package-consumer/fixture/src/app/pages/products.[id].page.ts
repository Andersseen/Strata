import { defineRouteMeta } from "@analogjs/router";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { strataDocumentNavigationGuard } from "@strata-sc/server-components/navigation";

import { ProductDetailsServerComponent } from "../products/product-details.server-component";

// Opt in to the experimental document-navigation fallback: a later Angular Router
// activation of this route becomes a real document request.
export const routeMeta = defineRouteMeta({
  canActivate: [strataDocumentNavigationGuard],
});

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
