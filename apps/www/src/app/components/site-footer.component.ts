import { ChangeDetectionStrategy, Component } from "@angular/core";
import { VoltButton, VoltCard, VoltCardContent, VoltSeparator } from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnGithubIcon } from "lumen-icons/github";

@Component({
  selector: "strata-site-footer",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    LmnGithubIcon,
    VoltButton,
    VoltCard,
    VoltCardContent,
    VoltSeparator,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="cta-section section-wrap">
      <volt-card [moveInView]="{ opacity: [0, 1], y: [22, 0] }" moveInViewOnce="true"
        ><volt-card-content>
          <p class="eyebrow">EARLY, OPEN, AND DELIBERATE</p>
          <h2>Build the next layer with us.</h2>
          <p>
            Strata is experimental today. The design work is public, the boundaries are explicit,
            and contributions are welcome.
          </p>
          <volt-button class="primary-action" (click)="openGitHub()"
            >View on GitHub <lmn-github [size]="16"
          /></volt-button> </volt-card-content
      ></volt-card>
    </section>
    <footer class="footer section-wrap">
      <a class="brand" href="#top"
        ><img class="brand-logo" src="/strata-mark.svg" width="28" height="28" alt="" /><span
          >strata</span
        ></a
      >
      <p>Structured server applications for Angular and Analog.</p>
      <volt-separator orientation="vertical" />
      <p>MIT © {{ year }}</p>
    </footer>`,
})
export class SiteFooterComponent {
  protected readonly year = new Date().getFullYear();

  protected openGitHub(): void {
    window.open("https://github.com/Andersseen/Strata", "_blank", "noopener,noreferrer");
  }
}
