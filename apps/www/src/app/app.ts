import { DOCUMENT, isPlatformBrowser } from "@angular/common";
import { afterNextRender, ChangeDetectionStrategy, Component, inject, PLATFORM_ID } from "@angular/core";
import { VoltBadge, VoltSeparator } from "@voltui/components";

import { ArchitectureSectionComponent } from "./components/architecture-section.component";
import { ExamplesSectionComponent } from "./components/examples-section.component";
import { FeatureSectionComponent } from "./components/feature-section.component";
import { HeroComponent } from "./components/hero.component";
import { SiteFooterComponent } from "./components/site-footer.component";
import { SiteHeaderComponent } from "./components/site-header.component";

@Component({
  selector: "app-root",
  imports: [
    SiteHeaderComponent,
    HeroComponent,
    FeatureSectionComponent,
    ExamplesSectionComponent,
    ArchitectureSectionComponent,
    SiteFooterComponent,
    VoltBadge,
    VoltSeparator,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="site-shell">
    <strata-site-header />
    <main id="top">
      <strata-hero />
      <section class="proof-strip section-wrap">
        <p>Built for the stack you already use</p>
        <div class="proof-technologies">
          <volt-badge variant="secondary">Angular</volt-badge><volt-separator orientation="vertical" />
          <volt-badge variant="secondary">Analog</volt-badge><volt-separator orientation="vertical" />
          <volt-badge variant="secondary">Nitro</volt-badge><volt-separator orientation="vertical" />
          <volt-badge variant="secondary">H3</volt-badge><volt-separator orientation="vertical" />
          <volt-badge variant="secondary">TypeScript</volt-badge>
        </div>
      </section>
      <strata-feature-section /><strata-examples-section /><strata-architecture-section /><strata-site-footer />
    </main>
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
