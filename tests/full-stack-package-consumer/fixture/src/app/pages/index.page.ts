import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterLink } from "@angular/router";

// `#to-product` is a plain `href` (document navigation). `#router-link` is an
// Angular Router link into a route that opts in to `strataDocumentNavigationGuard`.
@Component({
  selector: "app-home-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `<main>
    <h1>Full-stack consumer home</h1>
    <a id="to-product" href="/products/42">Product (document link)</a>
    <a id="router-link" routerLink="/products/42" [queryParams]="{ ref: 'home' }" fragment="details"
      >Product (router link)</a
    >
  </main>`,
})
export default class HomePage {}
