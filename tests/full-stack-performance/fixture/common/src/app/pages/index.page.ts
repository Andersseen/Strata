import { ChangeDetectionStrategy, Component } from "@angular/core";

@Component({
  selector: "app-home-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main>
    <h1>Performance baseline home</h1>
    <a id="to-product" href="/products/42">Product (document link)</a>
  </main>`,
})
export default class HomePage {}
