import { ChangeDetectionStrategy, Component } from "@angular/core";
import {
  VoltBadge,
  VoltButton,
  VoltCard,
  VoltCardContent,
} from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnArrowRightIcon } from "lumen-icons/arrow-right";
import { LmnArrowUpRightIcon } from "lumen-icons/arrow-up-right";
import { LmnBoltIcon } from "lumen-icons/bolt";
import { LmnCubeTransparentIcon } from "lumen-icons/cube-transparent";
import { LmnSparklesIcon } from "lumen-icons/sparkles";

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
    LmnSparklesIcon,
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
      <p class="eyebrow">SERVER ARCHITECTURE FOR THE ANGULAR ERA</p>
      <h1>Give your server <em>structure.</em></h1>
      <p class="hero-lede">
        Strata turns controllers and routes into clear, declarative layers—without taking ownership
        of the H3 runtime you already trust.
      </p>
      <div class="hero-actions">
        <volt-button class="primary-action" (click)="scrollTo('example')"
          >See it in action <lmn-arrow-right [size]="16" />
        </volt-button
        ><volt-button class="secondary-action" variant="ghost" (click)="openSource()"
          >Read the source <lmn-arrow-up-right [size]="16" />
        </volt-button>
      </div>
      <div class="hero-meta">
        <span><b>Angular</b> native</span><i></i><span><b>H3</b> powered</span><i></i
        ><span><b>Analog</b> ready</span>
      </div>
    </div>
    <div
      class="hero-visual"
      [moveInitial]="{ opacity: 0, y: 36, scale: 0.97 }"
      [moveAnimate]="{ opacity: 1, y: 0, scale: 1 }"
      moveDuration="800"
      moveDelay="140"
    >
      <div class="diagram-grid"></div>
      <div class="orbit orbit-one"></div>
      <div class="orbit orbit-two"></div>
      <volt-card class="layer-card layer-app"><volt-card-content>
        <span class="layer-icon"><lmn-cube-transparent [size]="20" /></span>
        <div><b>Your application</b><small>Controllers &amp; domain logic</small></div>
        <span class="node-status"></span>
      </volt-card-content></volt-card>
      <div class="layer-line line-one"></div>
      <volt-card class="layer-card layer-strata"><volt-card-content>
        <span class="layer-icon strata-icon"><lmn-sparkles [size]="20" /></span>
        <div><b>Strata</b><small>Metadata &amp; composition</small></div>
        <span class="node-status"></span>
      </volt-card-content></volt-card>
      <div class="layer-line line-two"></div>
      <volt-card class="layer-card layer-h3"><volt-card-content>
        <span class="layer-icon"><lmn-bolt [size]="20" /></span>
        <div><b>H3 / Nitro</b><small>The runtime stays yours</small></div>
        <span class="node-status"></span>
      </volt-card-content></volt-card>
      <p class="visual-caption">A thinner layer, a clearer boundary.</p>
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
