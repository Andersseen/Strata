import { DOCUMENT, isPlatformBrowser } from "@angular/common";
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  PLATFORM_ID,
} from "@angular/core";
import { RouterOutlet } from "@angular/router";

import { BackToTopComponent } from "./components/back-to-top.component";
import { SiteFooterComponent } from "./components/site-footer.component";
import { SiteHeaderComponent } from "./components/site-header.component";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, SiteHeaderComponent, SiteFooterComponent, BackToTopComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="site-shell" id="top">
    <strata-site-header />
    <router-outlet />
    <strata-site-footer />
    <strata-back-to-top />
  </div>`,
})
export class App {
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;

    // Styles are imported before Angular bootstraps. Waiting for two frames keeps
    // the skeleton in place until the styled, hydrated landing can paint.
    afterNextRender(() => {
      const view = this.document.defaultView;
      const reveal = () => {
        this.document.documentElement.setAttribute("data-app-ready", "true");
        this.document.getElementById("app-preload")?.setAttribute("aria-hidden", "true");
      };

      if (!view) {
        reveal();
        return;
      }

      const nextFrame =
        typeof view.requestAnimationFrame === "function"
          ? (callback: FrameRequestCallback) => view.requestAnimationFrame(callback)
          : (callback: FrameRequestCallback) => view.setTimeout(callback, 0);
      nextFrame(() => nextFrame(reveal));
    });
  }
}
