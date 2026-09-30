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
import { LmnCodeBracketIcon } from "lumen-icons/code-bracket";
import { LmnCursorArrowRaysIcon } from "lumen-icons/cursor-arrow-rays";
import { LmnLockClosedIcon } from "lumen-icons/lock-closed";

@Component({
  selector: "strata-feature-section",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    LmnArrowRightIcon,
    LmnCodeBracketIcon,
    LmnCursorArrowRaysIcon,
    LmnLockClosedIcon,
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
      <p class="eyebrow">ONE SERVER MODEL</p>
      <h2>Server-first, by construction.</h2>
      <p>
        Strata makes server-side Angular a coherent application model: server-rendered UI, explicit
        client islands and structured HTTP APIs, built on Angular primitives and the Analog/Nitro
        runtime.
      </p>
    </div>
    <div class="feature-grid">
      <volt-card
        class="feature-card"
        [moveInView]="{ opacity: [0, 1], y: [28, 0] }"
        moveInViewOnce="true"
        ><volt-card-header>
          <span class="feature-icon"><lmn-lock-closed [size]="24" /></span>
          <volt-card-title>Server-only by construction</volt-card-title> </volt-card-header
        ><volt-card-content
          ><p>
            Component implementations, repositories and server dependencies never enter the browser
            graph. The build swaps each Server Component for an empty surrogate.
          </p> </volt-card-content
        ><volt-card-footer
          ><a href="#server-components"
            >See the module graph <lmn-arrow-right [size]="16"
          /></a> </volt-card-footer
      ></volt-card>
      <volt-card
        class="feature-card feature-card-highlight"
        [moveInView]="{ opacity: [0, 1], y: [28, 0] }"
        moveInViewOnce="true"
        moveDelay="100"
        ><volt-card-header>
          <span class="feature-icon"><lmn-cursor-arrow-rays [size]="24" /></span>
          <volt-card-title>Interactive where needed</volt-card-title> </volt-card-header
        ><volt-card-content
          ><p>
            Mark explicit client boundaries with <code>[strataClient]</code>. Only those Angular
            components hydrate, from plain-data props the server serialized.
          </p> </volt-card-content
        ><volt-card-footer
          ><a href="#server-components-code"
            >See a client boundary <lmn-arrow-right [size]="16"
          /></a> </volt-card-footer
      ></volt-card>
      <volt-card
        class="feature-card"
        [moveInView]="{ opacity: [0, 1], y: [28, 0] }"
        moveInViewOnce="true"
        moveDelay="200"
        ><volt-card-header>
          <span class="feature-icon"><lmn-code-bracket [size]="24" /></span>
          <volt-card-title>Structured APIs</volt-card-title> </volt-card-header
        ><volt-card-content
          ><p>
            Use Angular-native controllers when you need HTTP endpoints, registered on the Nitro
            router you already own.
          </p> </volt-card-content
        ><volt-card-footer>
          <a href="#controllers"
            >See a controller <lmn-arrow-right [size]="16"
          /></a> </volt-card-footer
      ></volt-card>
    </div>
  </section>`,
})
export class FeatureSectionComponent {}
