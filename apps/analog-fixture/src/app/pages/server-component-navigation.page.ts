import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { Router, RouterLink } from "@angular/router";

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
      <li>
        <a routerLink="/server-component" [queryParams]="{ product: 42 }" fragment="details"
          >Router navigation with document fallback</a
        >
      </li>
      <li><a routerLink="/server-component-unprotected">Router navigation (control)</a></li>
    </ul>
    <button type="button" (click)="navigateProgrammatically()">
      Programmatic navigation with document fallback
    </button>
  </main>`,
})
export default class ServerComponentNavigationPage {
  private readonly router = inject(Router);

  navigateProgrammatically(): void {
    void this.router.navigateByUrl("/server-component?product=43#details");
  }
}
