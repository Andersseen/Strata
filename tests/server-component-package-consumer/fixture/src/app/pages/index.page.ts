import { ChangeDetectionStrategy, Component } from "@angular/core";

// Plain `href` links: document navigation. Angular Router navigation into a
// Server Component subtree is not supported (README: Experimental restrictions).
@Component({
  selector: "app-home-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main>
    <h1>External consumer home</h1>
    <a id="to-product" href="/product">Product (document link)</a>
  </main>`,
})
export default class HomePage {}
