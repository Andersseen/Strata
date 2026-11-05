import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RESPONSE } from "@analogjs/router/tokens";

/**
 * Application-owned not-found page. Without a catch-all route an unmatched URL is a router error:
 * native Analog answers it with an empty HTTP 200 shell, and the SSR failure contract
 * (render-failure-status.ts) would rightly refuse that as a failed render. A real page with a 404
 * status is the honest answer; it is an Analog HTML page, never the `/api` boundary's JSON 404.
 */
@Component({
  selector: "app-not-found-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main id="not-found-page"><h1>Page not found</h1></main>`,
})
export default class NotFoundPage {
  constructor() {
    const response = inject(RESPONSE, { optional: true });
    if (response) response.statusCode = 404;
  }
}
