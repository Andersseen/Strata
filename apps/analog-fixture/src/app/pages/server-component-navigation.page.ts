import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterLink } from "@angular/router";

/**
 * Origin page of the server-component navigation PoC
 * (docs/research/server-component-navigation-poc.md). An ordinary
 * client-capable page with two links to the same destination: a plain anchor
 * (full document navigation) and a RouterLink (Angular client navigation).
 */
@Component({
  selector: "app-server-component-navigation-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `<main>
    <h1>Server Component Navigation Probe</h1>
    <ul>
      <li><a href="/server-component">Document navigation</a></li>
      <li><a routerLink="/server-component">Router navigation</a></li>
    </ul>
  </main>`,
})
export default class ServerComponentNavigationPage {}
