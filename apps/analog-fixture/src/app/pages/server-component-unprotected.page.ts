import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterLink } from "@angular/router";

import { ProductDetailsComponent } from "../server-component/product-details.component";

/**
 * Deliberately unprotected control route for the navigation qualification.
 * It preserves the historical empty-surrogate regression without giving the
 * production-style guarded route a URL-controllable bypass.
 */
@Component({
  selector: "app-server-component-unprotected-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsComponent, RouterLink],
  template: `<main>
      <product-details />
    </main>
    <nav>
      <a routerLink="/server-component-navigation">Leave (router)</a>
    </nav>`,
})
export default class ServerComponentUnprotectedPage {}
