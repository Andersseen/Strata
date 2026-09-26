import { ChangeDetectionStrategy, Component } from "@angular/core";

import { ProductDetailsComponent } from "../server-component/product-details.component";

/**
 * Server-component graph PoC (docs/research/server-component-graph-poc.md).
 * An ordinary universal page: it imports the server component like any other
 * component, and the build decides what each graph receives.
 */
@Component({
  selector: "app-server-component-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsComponent],
  template: `<main>
    <product-details />
  </main>`,
})
export default class ServerComponentPage {}
