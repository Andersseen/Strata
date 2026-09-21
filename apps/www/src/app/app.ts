import { ChangeDetectionStrategy, Component } from "@angular/core";

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
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="site-shell">
    <strata-site-header />
    <main id="top">
      <strata-hero />
      <section class="proof-strip section-wrap">
        <p>Built for the stack you already use</p>
        <div>
          <span>Angular</span><span>Analog</span><span>Nitro</span><span>H3</span
          ><span>TypeScript</span>
        </div>
      </section>
      <strata-feature-section /><strata-examples-section /><strata-architecture-section /><strata-site-footer />
    </main>
  </div>`,
})
export class App {}
