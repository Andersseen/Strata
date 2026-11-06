import { RESPONSE } from "@analogjs/router/tokens";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { VoltButton } from "@voltui/components";

@Component({
  selector: "strata-not-found",
  imports: [VoltButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main id="main" tabindex="-1" class="section-wrap not-found">
    <h1>Page not found</h1>
    <p>This page does not exist.</p>
    <a voltButton href="/">Back to Strata</a>
  </main>`,
  styles: `
    .not-found {
      min-height: 60vh;
      padding-block: 8rem 4rem;
    }
    p {
      margin-block: 1rem 2rem;
      color: var(--strata-muted);
    }
  `,
})
export default class NotFoundPage {
  constructor() {
    const response = inject(RESPONSE, { optional: true });

    if (response) response.statusCode = 404;
  }
}
