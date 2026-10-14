import { ChangeDetectionStrategy, Component } from "@angular/core";
import { defineRouteMeta } from "@analogjs/router";
import { RouterLink } from "@angular/router";

import { serverComponentDocumentNavigation } from "../server-component-document-navigation";
import { ProductDetailsComponent } from "../server-component/product-details.component";

export const routeMeta = defineRouteMeta({
  canActivate: [serverComponentDocumentNavigation],
});

/**
 * Server-component graph PoC (docs/research/server-component-graph-poc.md).
 * An ordinary universal page: it imports the server component like any other
 * component, and the build decides what each graph receives. The router
 * link lets the navigation PoC (server-component-navigation.page.ts) leave
 * a hydrated server component through Angular, to observe island teardown.
 */
@Component({
  selector: "app-server-component-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductDetailsComponent, RouterLink],
  template: `<main>
      <product-details />
    </main>
    <nav>
      <a routerLink="/server-component-navigation">Leave (router)</a>
    </nav>`,
})
export default class ServerComponentPage {}
