import { ChangeDetectionStrategy, Component } from "@angular/core";
import {
  VoltNavigationMenu,
  VoltNavigationMenuItem,
  VoltNavigationMenuLink,
  VoltNavigationMenuList,
} from "@voltui/components";
import { LmnGithubIcon } from "lumen-icons/github";

import { ThemeToggleComponent } from "./theme-toggle.component";

@Component({
  selector: "strata-site-header",
  imports: [
    LmnGithubIcon,
    ThemeToggleComponent,
    VoltNavigationMenu,
    VoltNavigationMenuItem,
    VoltNavigationMenuLink,
    VoltNavigationMenuList,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="site-header">
    <nav class="nav-wrap" aria-label="Primary navigation">
      <a class="brand" href="#top" aria-label="Strata home"
        ><img class="brand-logo" src="/strata-mark.svg" width="28" height="28" alt="" /><span
          >strata</span
        ></a
      >
      <volt-navigation-menu class="nav-links" aria-label="Strata sections">
        <volt-navigation-menu-list>
          <volt-navigation-menu-item><a voltNavigationMenuLink href="#why">Why Strata</a></volt-navigation-menu-item>
          <volt-navigation-menu-item><a voltNavigationMenuLink href="#example">Example</a></volt-navigation-menu-item>
          <volt-navigation-menu-item><a voltNavigationMenuLink href="#architecture">Architecture</a></volt-navigation-menu-item>
        </volt-navigation-menu-list>
      </volt-navigation-menu>
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
