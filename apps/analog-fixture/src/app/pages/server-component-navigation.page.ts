import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import {
  StrataDocumentLink,
  StrataDocumentNavigator,
} from "@strata-sc/server-components/navigation";

/**
 * Origin page of the server-component navigation PoC
 * (docs/research/server-component-navigation-poc.md). An ordinary
 * client-capable page with two links to the same destination: a plain anchor
 * (full document navigation) and a RouterLink (Angular client navigation).
 */
@Component({
  selector: "app-server-component-navigation-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StrataDocumentLink],
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
      <li>
        <a
          [strataDocumentLink]="['/server-component']"
          [queryParams]="{ product: 42, label: 'a b&c' }"
          fragment="details"
          >Document link</a
        >
      </li>
      <li>
        <a [strataDocumentLink]="['/server-component']" target="_blank">Document link in new tab</a>
      </li>
    </ul>
    <button type="button" (click)="navigateProgrammatically()">
      Programmatic navigation with document fallback
    </button>
    <button type="button" (click)="navigateToDocument()">Programmatic document navigation</button>
  </main>`,
})
export default class ServerComponentNavigationPage {
  private readonly router = inject(Router);
  private readonly documentNavigator = inject(StrataDocumentNavigator);

  navigateToDocument(): void {
    this.documentNavigator.navigate(["/server-component"], {
      queryParams: { product: 43 },
      fragment: "details",
    });
  }

  navigateProgrammatically(): void {
    void this.router.navigateByUrl("/server-component?product=43#details");
  }
}
