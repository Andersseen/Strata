import { ChangeDetectionStrategy, Component } from "@angular/core";

@Component({
  selector: "app-about-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main>
    <h1>About</h1>
    <a id="to-product" href="/product">Product (document link)</a>
  </main>`,
})
export default class AboutPage {}
