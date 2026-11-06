import { ChangeDetectionStrategy, Component } from "@angular/core";
import {
  VoltBadge,
  VoltCard,
  VoltCardContent,
  VoltTabs,
  VoltTabsContent,
  VoltTabsList,
  VoltTabsTrigger,
} from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnArrowUpRightIcon } from "lumen-icons/arrow-up-right";
import { LmnBookOpenIcon } from "lumen-icons/book-open";
import { LmnCommandLineIcon } from "lumen-icons/command-line";
import { LmnServerStackIcon } from "lumen-icons/server-stack";
import { LmnSquare3Stack3dIcon } from "lumen-icons/square-3-stack-3d";

import { INSTALL_EXAMPLE, VITE_CONFIG_EXAMPLE } from "../content";
import { SITE_LINKS } from "../links";

import { CodePanelComponent } from "./code-panel.component";

@Component({
  selector: "strata-quick-start-section",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    CodePanelComponent,
    LmnArrowUpRightIcon,
    LmnBookOpenIcon,
    LmnCommandLineIcon,
    LmnServerStackIcon,
    LmnSquare3Stack3dIcon,
    VoltBadge,
    VoltCard,
    VoltCardContent,
    VoltTabs,
    VoltTabsContent,
    VoltTabsList,
    VoltTabsTrigger,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section id="start" class="start-section section-wrap" aria-labelledby="start-title">
    <div
      class="section-heading compact"
      [moveInView]="{ opacity: [0, 1], y: [24, 0] }"
      moveInViewOnce="true"
    >
      <p class="eyebrow">QUICK START</p>
      <h2 id="start-title">From install to first island in two files.</h2>
      <p>
        Add the packages to an existing Analog app, then put the Vite plugin in front of
        <code>analog()</code>. Your next <code>&#64;ServerComponent()</code> stays on the server.
      </p>
    </div>

    <div class="start-grid" [moveInView]="{ opacity: [0, 1], y: [28, 0] }" moveInViewOnce="true">
      <ol class="start-steps">
        <li>
          <volt-badge variant="outline" class="step-index">1</volt-badge>
          <div>
            <b>Install</b>
            <p>Server Components and controllers are separate packages; take only what you need.</p>
          </div>
        </li>
        <li>
          <volt-badge variant="outline" class="step-index">2</volt-badge>
          <div>
            <b>Configure Vite</b>
            <p>
              The plugin runs before <code>analog()</code> and generates browser surrogates in a
              gitignored folder.
            </p>
          </div>
        </li>
        <li>
          <volt-badge variant="outline" class="step-index">3</volt-badge>
          <div>
            <b>Mark a component</b>
            <p>
              Add <code>&#64;ServerComponent()</code>, then name what hydrates with
              <code>[strataClient]</code>, as in
              <a href="#server-components-code">the example above</a>.
            </p>
          </div>
        </li>
      </ol>

      <volt-tabs class="integration-tabs start-tabs" value="install">
        <volt-tabs-list>
          <volt-tabs-trigger value="install">1 · Install</volt-tabs-trigger>
          <volt-tabs-trigger value="vite">2 · vite.config.ts</volt-tabs-trigger>
        </volt-tabs-list>
        <volt-tabs-content value="install"
          ><strata-code-panel filename="terminal" language="shell" [code]="installExample"
        /></volt-tabs-content>
        <volt-tabs-content value="vite"
          ><strata-code-panel filename="vite.config.ts" [code]="viteExample"
        /></volt-tabs-content>
      </volt-tabs>
    </div>

    <div class="resource-grid">
      @for (resource of resources; track resource.title; let index = $index) {
        <a
          class="resource-link"
          [href]="resource.href"
          [attr.target]="resource.href.startsWith('/') ? null : '_blank'"
          [attr.rel]="resource.href.startsWith('/') ? null : 'noopener noreferrer'"
          [moveInView]="{ opacity: [0, 1], y: [20, 0] }"
          moveInViewOnce="true"
          [moveDelay]="index * 80"
        >
          <volt-card class="resource-card" moveWhileHover="lift"
            ><volt-card-content>
              <span class="feature-icon">
                @switch (resource.icon) {
                  @case ("book") {
                    <lmn-book-open [size]="20" />
                  }
                  @case ("stack") {
                    <lmn-square-3-stack-3d [size]="20" />
                  }
                  @case ("server") {
                    <lmn-server-stack [size]="20" />
                  }
                  @default {
                    <lmn-command-line [size]="20" />
                  }
                }
              </span>
              <b>{{ resource.title }} <lmn-arrow-up-right [size]="14" /></b>
              <small>{{ resource.description }}</small>
            </volt-card-content></volt-card
          >
        </a>
      }
    </div>
  </section>`,
})
export class QuickStartSectionComponent {
  protected readonly installExample = INSTALL_EXAMPLE;
  protected readonly viteExample = VITE_CONFIG_EXAMPLE;
  protected readonly resources = [
    {
      icon: "book",
      title: "Getting started",
      description: "What is published, prerequisites and which path to pick.",
      href: SITE_LINKS.gettingStarted,
    },
    {
      icon: "stack",
      title: "Server Components",
      description: "The package reference: boundaries, props protocol, dev server.",
      href: SITE_LINKS.npmServerComponents,
    },
    {
      icon: "server",
      title: "Controllers",
      description: "Standard-decorator controllers registered on Nitro's router.",
      href: SITE_LINKS.npmAnalog,
    },
    {
      icon: "terminal",
      title: "Source & releases",
      description: "Design records, qualification gates and changelogs on GitHub.",
      href: SITE_LINKS.github,
    },
  ] as const;
}
