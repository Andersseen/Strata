import { ChangeDetectionStrategy, Component } from "@angular/core";
import { VoltCard, VoltCardContent, VoltNativeButton } from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnBookOpenIcon } from "lumen-icons/book-open";
import { LmnGithubIcon } from "lumen-icons/github";

import { SITE_LINKS } from "../links";

@Component({
  selector: "strata-site-footer",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    LmnBookOpenIcon,
    LmnGithubIcon,
    VoltCard,
    VoltCardContent,
    VoltNativeButton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="cta-section section-wrap">
      <volt-card [moveInView]="{ opacity: [0, 1], y: [22, 0] }" moveInViewOnce="true"
        ><volt-card-content>
          <p class="eyebrow">EARLY, OPEN, AND DELIBERATE</p>
          <h2>Build the next layer with us.</h2>
          <p>
            Strata is experimental today. Server Components and controllers ship as 0.x packages on
            npm, and Server Components are dogfooded on this site. The design work is public and
            contributions are welcome.
          </p>
          <div class="cta-actions">
            <a
              voltButton
              class="primary-action"
              moveWhileHover="lift"
              moveWhileTap="press"
              [href]="links.github"
              target="_blank"
              rel="noopener noreferrer"
              >View on GitHub <lmn-github [size]="16"
            /></a>
            <a
              voltButton
              variant="outline"
              class="secondary-action"
              moveWhileHover="lift"
              moveWhileTap="press"
              [href]="links.docs"
              ><lmn-book-open [size]="16" />Documentation</a
            >
          </div>
        </volt-card-content></volt-card
      >
    </section>
    <footer class="footer section-wrap">
      <div class="footer-brand">
        <a class="brand" href="/"
          ><img class="brand-logo" src="/strata-mark.svg" width="28" height="28" alt="" /><span
            >strata</span
          ></a
        >
        <p>Server Components and structured APIs for Angular and Analog.</p>
      </div>
      <nav class="footer-columns" aria-label="Footer">
        @for (column of columns; track column.title) {
          <div>
            <h3>{{ column.title }}</h3>
            <ul>
              @for (item of column.items; track item.label) {
                <li>
                  <a
                    [href]="item.href"
                    [attr.target]="item.href.startsWith('/') ? null : '_blank'"
                    [attr.rel]="item.href.startsWith('/') ? null : 'noopener noreferrer'"
                    >{{ item.label }}</a
                  >
                </li>
              }
            </ul>
          </div>
        }
      </nav>
      <div class="footer-bottom">
        <p>MIT © {{ year }} Strata contributors</p>
        <p>Built with Analog, Strata Server Components, Volt UI and Angular Movement.</p>
      </div>
    </footer>`,
})
export class SiteFooterComponent {
  protected readonly year = new Date().getFullYear();
  protected readonly links = SITE_LINKS;
  protected readonly columns = [
    {
      title: "Project",
      items: [
        { label: "Documentation", href: SITE_LINKS.docs },
        { label: "Getting started", href: SITE_LINKS.gettingStarted },
        { label: "Releases", href: SITE_LINKS.releases },
        { label: "Issues", href: SITE_LINKS.issues },
      ],
    },
    {
      title: "Packages",
      items: [
        { label: "@strata-sc/server-components", href: SITE_LINKS.npmServerComponents },
        { label: "@strata-sc/core", href: SITE_LINKS.npmCore },
        { label: "@strata-sc/analog", href: SITE_LINKS.npmAnalog },
      ],
    },
    {
      title: "Ecosystem",
      items: [
        { label: "AnalogJS", href: SITE_LINKS.analog },
        { label: "Volt UI", href: SITE_LINKS.voltUi },
        { label: "Angular Movement", href: SITE_LINKS.angularMovement },
        { label: "Lumen Icons", href: SITE_LINKS.lumenIcons },
      ],
    },
  ] as const;
}
