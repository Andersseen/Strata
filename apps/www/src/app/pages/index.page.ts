import { ChangeDetectionStrategy, Component } from "@angular/core";
import { VoltBadge, VoltSeparator } from "@voltui/components";

import { ArchitectureSectionComponent } from "../components/architecture-section.component";
import { ExamplesSectionComponent } from "../components/examples-section.component";
import { FeatureSectionComponent } from "../components/feature-section.component";
import { HeroComponent } from "../components/hero.component";
import { QuickStartSectionComponent } from "../components/quick-start-section.component";
import { ServerComponentsCodeComponent } from "../components/server-components-code.component";
import { ServerComponentsShowcaseComponent } from "../server-components/server-components-showcase.component";

@Component({
  selector: "strata-landing-page",
  imports: [
    HeroComponent,
    FeatureSectionComponent,
    ExamplesSectionComponent,
    ArchitectureSectionComponent,
    ServerComponentsShowcaseComponent,
    ServerComponentsCodeComponent,
    QuickStartSectionComponent,
    VoltBadge,
    VoltSeparator,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main id="main" tabindex="-1">
    <strata-hero />
    <section class="proof-strip section-wrap" aria-label="Capabilities and stack">
      <div class="proof-group">
        <p>What Strata adds</p>
        <div class="proof-capabilities">
          <volt-badge>Server Components</volt-badge>
          <volt-badge variant="outline">Client islands</volt-badge>
          <volt-badge variant="outline">Controllers</volt-badge>
        </div>
      </div>
      <div class="proof-group">
        <p>Built on the stack you use</p>
        <div class="proof-technologies">
          <volt-badge variant="secondary">Angular</volt-badge
          ><volt-separator orientation="vertical" />
          <volt-badge variant="secondary">Analog</volt-badge
          ><volt-separator orientation="vertical" />
          <volt-badge variant="secondary">Nitro</volt-badge
          ><volt-separator orientation="vertical" /> <volt-badge variant="secondary">H3</volt-badge
          ><volt-separator orientation="vertical" />
          <volt-badge variant="secondary">TypeScript</volt-badge>
        </div>
      </div>
    </section>
    <strata-server-components-showcase />
    <strata-server-components-code />
    <strata-feature-section />
    <strata-examples-section />
    <strata-architecture-section />
    <strata-quick-start-section />
  </main>`,
})
export default class LandingPage {}
