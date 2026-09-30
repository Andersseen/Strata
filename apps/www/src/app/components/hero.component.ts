import { ChangeDetectionStrategy, Component } from "@angular/core";
import { VoltBadge, VoltButton, VoltCard, VoltCardContent } from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnArrowRightIcon } from "lumen-icons/arrow-right";
import { LmnArrowUpRightIcon } from "lumen-icons/arrow-up-right";
import { LmnBoltIcon } from "lumen-icons/bolt";
import { LmnCubeTransparentIcon } from "lumen-icons/cube-transparent";
import { LmnServerStackIcon } from "lumen-icons/server-stack";
import { LmnSparklesIcon } from "lumen-icons/sparkles";
import { LmnWindowIcon } from "lumen-icons/window";

@Component({
  selector: "strata-hero",
  imports: [
    VoltBadge,
    VoltButton,
    VoltCard,
    VoltCardContent,
    ...MOVEMENT_DIRECTIVES,
    LmnArrowRightIcon,
    LmnArrowUpRightIcon,
    LmnBoltIcon,
    LmnCubeTransparentIcon,
    LmnServerStackIcon,
    LmnSparklesIcon,
    LmnWindowIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="hero section-wrap">
    <div
      class="hero-copy"
      [moveInitial]="{ opacity: 0, y: 28 }"
      [moveAnimate]="{ opacity: 1, y: 0 }"
      moveDuration="650"
    >
      <volt-badge class="release-badge"
        ><span class="live-dot"></span>Experimental · pre-1.0</volt-badge
      >
      <p class="eyebrow">ANGULAR SERVER ARCHITECTURE</p>
      <h1>The server layer Angular <em>was missing.</em></h1>
      <p class="hero-lede">
        Strata brings Server Components to Angular and Analog: render components on the server, keep
        their code and dependencies out of the browser, and hydrate only the pieces that need
        interaction. When you need HTTP endpoints, structure them with Angular-native controllers.
      </p>
      <div class="hero-actions">
        <volt-button class="primary-action" (click)="scrollTo('server-components')"
          >See Server Components <lmn-arrow-right [size]="16" /> </volt-button
        ><volt-button class="secondary-action" variant="ghost" (click)="openSource()"
          >Read the source <lmn-arrow-up-right [size]="16" />
        </volt-button>
      </div>
      <div class="hero-meta">
        <span><b>Angular</b> native</span><i></i><span><b>Analog</b> + Nitro</span><i></i
        ><span><b>Server Components</b> preview</span>
      </div>
    </div>
    <div
      class="hero-visual"
      [moveInitial]="{ opacity: 0, y: 36, scale: 0.97 }"
      [moveAnimate]="{ opacity: 1, y: 0, scale: 1 }"
      moveDuration="800"
      moveDelay="140"
      role="img"
      aria-label="An Angular app uses two Strata capabilities, Server Components with client boundaries and controllers with HTTP routes, on the Analog and Nitro runtime."
    >
      <div class="diagram-grid"></div>
      <div class="orbit orbit-one"></div>
      <div class="orbit orbit-two"></div>
      <div class="stack-diagram" aria-hidden="true">
        <volt-card class="layer-card layer-app"
          ><volt-card-content>
            <span class="layer-icon"><lmn-cube-transparent [size]="20" /></span>
            <div><b>Angular app</b><small>Your components &amp; domain</small></div>
          </volt-card-content></volt-card
        >
        <div class="stack-fork"></div>
        <div class="stack-pillars">
          <volt-card class="layer-card layer-pillar layer-ui"
            ><volt-card-content>
              <span class="layer-icon strata-icon"><lmn-window [size]="16" /></span>
              <b>Server Components</b><small>UI · client boundaries</small>
            </volt-card-content></volt-card
          >
          <volt-card class="layer-card layer-pillar"
            ><volt-card-content>
              <span class="layer-icon"><lmn-server-stack [size]="16" /></span>
              <b>Controllers</b><small>HTTP · routes</small>
            </volt-card-content></volt-card
          >
        </div>
        <div class="stack-join"></div>
        <volt-card class="layer-card layer-strata"
          ><volt-card-content>
            <span class="layer-icon strata-icon"><lmn-sparkles [size]="20" /></span>
            <div><b>Strata</b><small>One server model</small></div>
            <span class="node-status"></span> </volt-card-content
        ></volt-card>
        <div class="stack-line"></div>
        <volt-card class="layer-card layer-h3"
          ><volt-card-content>
            <span class="layer-icon"><lmn-bolt [size]="20" /></span>
            <div><b>Analog / Nitro</b><small>The runtime stays yours</small></div>
          </volt-card-content></volt-card
        >
      </div>
      <p class="visual-caption">Two capabilities, one server model.</p>
    </div>
  </section>`,
})
export class HeroComponent {
  protected scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }

  protected openSource(): void {
    window.open("https://github.com/Andersseen/Strata", "_blank", "noopener,noreferrer");
  }
}
