import { ChangeDetectionStrategy, Component } from "@angular/core";
import {
  VoltCard,
  VoltCardContent,
  VoltCardFooter,
  VoltCardHeader,
  VoltCardTitle,
} from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnArrowRightIcon } from "lumen-icons/arrow-right";
import { LmnArrowUpRightIcon } from "lumen-icons/arrow-up-right";
import { LmnCheckCircleIcon } from "lumen-icons/check-circle";
import { LmnCodeBracketIcon } from "lumen-icons/code-bracket";
import { LmnCommandLineIcon } from "lumen-icons/command-line";

@Component({
  selector: "strata-feature-section",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    LmnArrowRightIcon,
    LmnArrowUpRightIcon,
    LmnCheckCircleIcon,
    LmnCodeBracketIcon,
    LmnCommandLineIcon,
    VoltCard,
    VoltCardContent,
    VoltCardFooter,
    VoltCardHeader,
    VoltCardTitle,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section id="why" class="feature-section section-wrap">
    <div
      class="section-heading"
      [moveInView]="{ opacity: [0, 1], y: [24, 0] }"
      moveInViewOnce="true"
    >
      <p class="eyebrow">INTENT, NOT INDIRECTION</p>
      <h2>Just enough framework.</h2>
      <p>
        Strata is deliberately narrow: a common language for your server, while the runtime, routing
        model and escape hatches remain familiar.
      </p>
    </div>
    <div class="feature-grid">
      <volt-card
        class="feature-card"
        [moveInView]="{ opacity: [0, 1], y: [28, 0] }"
        moveInViewOnce="true"
        ><volt-card-header>
          <span class="feature-icon"><lmn-code-bracket [size]="24" /></span>
          <volt-card-title>Declarative by default</volt-card-title> </volt-card-header
        ><volt-card-content
          ><p>
            Describe routes alongside the code that owns them. Metadata stays inspectable through a
            small public API.
          </p> </volt-card-content
        ><volt-card-footer
          ><a href="#example"
            >See a controller <lmn-arrow-right [size]="16"
          /></a> </volt-card-footer
      ></volt-card>
      <volt-card
        class="feature-card feature-card-highlight"
        [moveInView]="{ opacity: [0, 1], y: [28, 0] }"
        moveInViewOnce="true"
        moveDelay="100"
        ><volt-card-header>
          <span class="feature-icon"><lmn-command-line [size]="24" /></span>
          <volt-card-title>Runtime stays yours</volt-card-title> </volt-card-header
        ><volt-card-content
          ><p>
            No replacement server, no hidden transport. Register directly on H3—or on Nitro's router
            in Analog.
          </p> </volt-card-content
        ><volt-card-footer
          ><a href="#architecture"
            >Explore the boundary <lmn-arrow-right [size]="16"
          /></a> </volt-card-footer
      ></volt-card>
      <volt-card
        class="feature-card"
        [moveInView]="{ opacity: [0, 1], y: [28, 0] }"
        moveInViewOnce="true"
        moveDelay="200"
        ><volt-card-header>
          <span class="feature-icon"><lmn-check-circle [size]="24" /></span>
          <volt-card-title>Designed for server safety</volt-card-title> </volt-card-header
        ><volt-card-content
          ><p>
            Server controllers live under <code>src/server</code>, keeping implementation details
            outside the client graph.
          </p> </volt-card-content
        ><volt-card-footer>
          <a
            href="https://github.com/Andersseen/Strata/blob/main/docs/RELEASE-1.0.md"
            target="_blank"
            rel="noreferrer"
            >Read the release gates <lmn-arrow-up-right [size]="16"
          /></a> </volt-card-footer
      ></volt-card>
    </div>
  </section>`,
})
export class FeatureSectionComponent {}
