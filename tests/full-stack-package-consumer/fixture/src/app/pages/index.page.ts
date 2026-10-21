import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import {
  StrataDocumentLink,
  StrataDocumentNavigator,
} from "@strata-sc/server-components/navigation";

// `#to-product` is a plain `href` (document navigation). `#router-link` is an
// Angular Router link into a route that opts in to `strataDocumentNavigationGuard`.
// `#strata-link` and `#navigate` use the package's own document-navigation APIs.
@Component({
  selector: "app-home-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StrataDocumentLink],
  template: `<main>
    <h1>Full-stack consumer home</h1>
    <a id="to-product" href="/products/42">Product (document link)</a>
    <a id="router-link" routerLink="/products/42" [queryParams]="{ ref: 'home' }" fragment="details"
      >Product (router link)</a
    >
    <a
      id="strata-link"
      [strataDocumentLink]="['/products', 42]"
      [queryParams]="{ ref: 'link' }"
      fragment="details"
      >Product (StrataDocumentLink)</a
    >
    <button id="navigate" type="button" (click)="open()">Product (StrataDocumentNavigator)</button>
  </main>`,
})
export default class HomePage {
  private readonly documentNavigator = inject(StrataDocumentNavigator);

  open(): void {
    this.documentNavigator.navigate(["/products", 42], {
      queryParams: { ref: "nav" },
      fragment: "details",
    });
  }
}
