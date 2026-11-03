import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { VoltBadge, VoltCard, VoltCardContent, VoltNativeButton } from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnArrowRightIcon } from "lumen-icons/arrow-right";
import { LmnBoltIcon } from "lumen-icons/bolt";
import { LmnBookOpenIcon } from "lumen-icons/book-open";
import { LmnCheckIcon } from "lumen-icons/check";
import { LmnClipboardIcon } from "lumen-icons/clipboard";
import { LmnCubeTransparentIcon } from "lumen-icons/cube-transparent";
import { LmnServerStackIcon } from "lumen-icons/server-stack";
import { LmnSparklesIcon } from "lumen-icons/sparkles";
import { LmnWindowIcon } from "lumen-icons/window";

import { copyText } from "../clipboard";
import { SITE_LINKS } from "../links";

import { HeroStrataComponent } from "./hero-strata.component";

const INSTALL_COMMAND = "pnpm add @strata-sc/server-components";

@Component({
  selector: "strata-hero",
  imports: [
    VoltBadge,
    VoltCard,
    VoltCardContent,
    VoltNativeButton,
    ...MOVEMENT_DIRECTIVES,
    HeroStrataComponent,
    LmnArrowRightIcon,
    LmnBoltIcon,
    LmnBookOpenIcon,
    LmnCheckIcon,
    LmnClipboardIcon,
    LmnCubeTransparentIcon,
    LmnServerStackIcon,
    LmnSparklesIcon,
    LmnWindowIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="hero-stage">
    <strata-hero-strata />
    <section class="hero section-wrap">
      <div
        class="hero-copy"
        [moveInitial]="{ opacity: 0, y: 28 }"
        [moveAnimate]="{ opacity: 1, y: 0 }"
        moveDuration="650"
      >
        <a class="release-link" [href]="links.releases" target="_blank" rel="noopener noreferrer"
          ><volt-badge class="release-badge"
            ><span class="live-dot" moveLoop="pulse" moveDuration="2400"></span>Experimental ·
            pre-1.0<span class="release-sep"></span><span class="release-cta">Release notes</span
            ><lmn-arrow-right [size]="12" /></volt-badge
        ></a>
        <p class="eyebrow">ANGULAR SERVER ARCHITECTURE</p>
        <h1>The server layer Angular <em>was missing.</em></h1>
        <p class="hero-lede">
          Strata brings Server Components to Angular and Analog: render components on the server,
          keep their code and dependencies out of the browser, and hydrate only the pieces that need
          interaction. When you need HTTP endpoints, structure them with Angular-native controllers.
        </p>
        <div class="hero-actions">
          <a
            voltButton
            class="primary-action"
            href="#server-components"
            moveWhileHover="lift"
            moveWhileTap="press"
            >See Server Components <lmn-arrow-right [size]="16"
          /></a>
          <a
            voltButton
            variant="outline"
            class="secondary-action"
            moveWhileHover="lift"
            moveWhileTap="press"
            [href]="links.gettingStarted"
            target="_blank"
            rel="noopener noreferrer"
            ><lmn-book-open [size]="16" />Read the docs</a
          >
        </div>
        <volt-card class="install-chip"
          ><volt-card-content>
            <span class="install-prompt" aria-hidden="true">$</span>
            <code>{{ installCommand }}</code>
            <button
              voltButton
              variant="ghost"
              size="icon"
              type="button"
              class="install-copy"
              moveWhileTap="press"
              [attr.aria-label]="copied() ? 'Install command copied' : 'Copy install command'"
              (click)="copyInstall()"
            >
              @if (copied()) {
                <lmn-check [size]="14" />
              } @else {
                <lmn-clipboard [size]="14" />
              }
            </button> </volt-card-content
        ></volt-card>
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
        <div class="orbit orbit-one"></div>
        <div class="orbit orbit-two"></div>
        <div class="stack-diagram" aria-hidden="true">
          <volt-card class="layer-card layer-app" moveWhileHover="lift"
            ><volt-card-content>
              <span class="layer-icon"><lmn-cube-transparent [size]="20" /></span>
              <div><b>Angular app</b><small>Your components &amp; domain</small></div>
            </volt-card-content></volt-card
          >
          <div class="stack-fork">
            <i
              class="flow-dot"
              [moveLoop]="{ y: [0, 6, 20, 26], opacity: [0, 1, 1, 0] }"
              moveDuration="2800"
              moveEasing="ease-in-out"
            ></i>
          </div>
          <div class="stack-pillars">
            <volt-card class="layer-card layer-pillar layer-ui" moveWhileHover="lift"
              ><volt-card-content>
                <span class="layer-icon strata-icon"><lmn-window [size]="16" /></span>
                <b>Server Components</b><small>UI · client boundaries</small>
              </volt-card-content></volt-card
            >
            <volt-card class="layer-card layer-pillar" moveWhileHover="lift"
              ><volt-card-content>
                <span class="layer-icon"><lmn-server-stack [size]="16" /></span>
                <b>Controllers</b><small>HTTP · routes</small>
              </volt-card-content></volt-card
            >
          </div>
          <div class="stack-join">
            <i
              class="flow-dot"
              [moveLoop]="{ y: [0, 6, 20, 26], opacity: [0, 1, 1, 0] }"
              moveDuration="2800"
              moveEasing="ease-in-out"
              moveDelay="900"
            ></i>
          </div>
          <volt-card class="layer-card layer-strata" moveWhileHover="lift"
            ><volt-card-content>
              <span class="layer-icon strata-icon"><lmn-sparkles [size]="20" /></span>
              <div><b>Strata</b><small>One server model</small></div>
              <span
                class="node-status"
                moveLoop="pulse"
                moveDuration="2400"
              ></span> </volt-card-content
          ></volt-card>
          <div class="stack-line">
            <i
              class="flow-dot"
              [moveLoop]="{ y: [0, 6, 20, 26], opacity: [0, 1, 1, 0] }"
              moveDuration="2800"
              moveEasing="ease-in-out"
              moveDelay="1800"
            ></i>
          </div>
          <volt-card class="layer-card layer-h3" moveWhileHover="lift"
            ><volt-card-content>
              <span class="layer-icon"><lmn-bolt [size]="20" /></span>
              <div><b>Analog / Nitro</b><small>The runtime stays yours</small></div>
            </volt-card-content></volt-card
          >
        </div>
        <p class="visual-caption">Two capabilities, one server model.</p>
      </div>
    </section>
  </div>`,
})
export class HeroComponent {
  protected readonly links = SITE_LINKS;
  protected readonly installCommand = INSTALL_COMMAND;
  protected readonly copied = signal(false);

  protected async copyInstall(): Promise<void> {
    await copyText(INSTALL_COMMAND);
    this.copied.set(true);
    window.setTimeout(() => this.copied.set(false), 1600);
  }
}
