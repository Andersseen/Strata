import { ChangeDetectionStrategy, Component } from "@angular/core";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnGithubIcon } from "lumen-icons/github";

@Component({
  selector: "strata-site-footer",
  imports: [...MOVEMENT_DIRECTIVES, LmnGithubIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="cta-section section-wrap">
      <div [moveInView]="{ opacity: [0, 1], y: [22, 0] }" moveInViewOnce="true">
        <p class="eyebrow">EARLY, OPEN, AND DELIBERATE</p>
        <h2>Build the next layer with us.</h2>
        <p>
          Strata is experimental today. The design work is public, the boundaries are explicit, and
          contributions are welcome.
        </p>
        <a
          class="primary-action"
          href="https://github.com/Andersseen/Strata"
          target="_blank"
          rel="noreferrer"
          >View on GitHub <lmn-github [size]="16"
        /></a>
      </div>
    </section>
    <footer class="footer section-wrap">
      <a class="brand" href="#top"
        ><span class="brand-mark"><span></span><span></span><span></span></span
        ><span>strata</span></a
      >
      <p>Structured server applications for Angular and Analog.</p>
      <p>MIT © {{ year }}</p>
    </footer>`,
})
export class SiteFooterComponent {
  protected readonly year = new Date().getFullYear();
}
