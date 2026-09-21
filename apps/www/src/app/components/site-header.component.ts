import { ChangeDetectionStrategy, Component } from "@angular/core";
import { LmnGithubIcon } from "lumen-icons/github";

import { ThemeToggleComponent } from "./theme-toggle.component";

@Component({
  selector: "strata-site-header",
  imports: [LmnGithubIcon, ThemeToggleComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="site-header">
    <nav class="nav-wrap" aria-label="Primary navigation">
      <a class="brand" href="#top" aria-label="Strata home"
        ><span class="brand-mark"><span></span><span></span><span></span></span
        ><span>strata</span></a
      >
      <div class="nav-links">
        <a href="#why">Why Strata</a><a href="#example">Example</a
        ><a href="#architecture">Architecture</a>
      </div>
      <div class="nav-actions">
        <a
          class="github-link"
          href="https://github.com/Andersseen/Strata"
          target="_blank"
          rel="noreferrer"
          aria-label="Open Strata on GitHub"
          ><lmn-github [size]="20" /></a
        ><strata-theme-toggle />
      </div>
    </nav>
  </header>`,
})
export class SiteHeaderComponent {}
