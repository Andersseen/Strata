import { isPlatformBrowser } from "@angular/common";
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  inject,
  NgZone,
  PLATFORM_ID,
  signal,
} from "@angular/core";
import {
  VoltDialogRoot,
  VoltDrawerClose,
  VoltDrawerContent,
  VoltDrawerOverlay,
  VoltDrawerTitle,
  VoltNativeButton,
  VoltNavigationMenu,
  VoltNavigationMenuItem,
  VoltNavigationMenuLink,
  VoltNavigationMenuList,
} from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnArrowUpRightIcon } from "lumen-icons/arrow-up-right";
import { LmnBars3Icon } from "lumen-icons/bars-3";
import { LmnGithubIcon } from "lumen-icons/github";
import { LmnXMarkIcon } from "lumen-icons/x-mark";

import { SECTION_LINKS, SITE_LINKS } from "../links";

import { ThemeToggleComponent } from "./theme-toggle.component";

@Component({
  selector: "strata-site-header",
  imports: [
    ...MOVEMENT_DIRECTIVES,
    LmnArrowUpRightIcon,
    LmnBars3Icon,
    LmnGithubIcon,
    LmnXMarkIcon,
    ThemeToggleComponent,
    VoltDialogRoot,
    VoltDrawerClose,
    VoltDrawerContent,
    VoltDrawerOverlay,
    VoltDrawerTitle,
    VoltNativeButton,
    VoltNavigationMenu,
    VoltNavigationMenuItem,
    VoltNavigationMenuLink,
    VoltNavigationMenuList,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<header class="site-header" [class.is-scrolled]="scrolled()">
      <a class="skip-link" href="#main">Skip to content</a>
      <nav class="nav-wrap" aria-label="Primary navigation">
        <a class="brand" href="#top" aria-label="Strata home"
          ><img class="brand-logo" src="/strata-mark.svg" width="28" height="28" alt="" /><span
            >strata</span
          ></a
        >
        <volt-navigation-menu class="nav-links" aria-label="Strata sections">
          <volt-navigation-menu-list>
            @for (link of sections; track link.id) {
              <volt-navigation-menu-item
                ><a
                  voltNavigationMenuLink
                  [href]="'#' + link.id"
                  [active]="active() === link.id"
                  [attr.aria-current]="active() === link.id ? 'location' : null"
                  >{{ link.label }}</a
                ></volt-navigation-menu-item
              >
            }
            <volt-navigation-menu-item
              ><a
                voltNavigationMenuLink
                class="nav-external"
                [href]="links.docs"
                target="_blank"
                rel="noopener noreferrer"
                >Docs <lmn-arrow-up-right [size]="12" /></a
            ></volt-navigation-menu-item>
          </volt-navigation-menu-list>
        </volt-navigation-menu>
        <div class="nav-actions">
          <a
            voltButton
            variant="ghost"
            size="icon"
            class="github-link"
            [href]="links.github"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open Strata on GitHub"
            ><lmn-github [size]="20" /></a
          ><strata-theme-toggle />
          <button
            voltButton
            variant="outline"
            size="icon"
            class="menu-button"
            type="button"
            aria-label="Open menu"
            aria-haspopup="dialog"
            [attr.aria-expanded]="menuOpen()"
            moveWhileTap="press"
            (click)="menuOpen.set(true)"
          >
            <lmn-bars-3 [size]="20" />
          </button>
        </div>
      </nav>
    </header>

    <ng-template voltDialogRoot [(open)]="menuOpen" let-close="close">
      <div voltDrawerOverlay></div>
      <div voltDrawerContent side="right" class="mobile-menu" aria-label="Site menu">
        <div class="mobile-menu-head">
          <h2 voltDrawerTitle class="brand">
            <img class="brand-logo" src="/strata-mark.svg" width="28" height="28" alt="" /><span
              >strata</span
            >
          </h2>
          <volt-drawer-close class="menu-close" label="Close menu"
            ><lmn-x-mark [size]="20"
          /></volt-drawer-close>
        </div>
        <volt-navigation-menu
          class="mobile-menu-links"
          orientation="vertical"
          aria-label="Strata sections"
        >
          <volt-navigation-menu-list moveStagger moveStaggerStep="50ms">
            @for (link of sections; track link.id) {
              <volt-navigation-menu-item move="fade-left"
                ><a
                  voltNavigationMenuLink
                  [href]="'#' + link.id"
                  [active]="active() === link.id"
                  (click)="close()"
                  >{{ link.label }}</a
                ></volt-navigation-menu-item
              >
            }
          </volt-navigation-menu-list>
        </volt-navigation-menu>
        <div class="mobile-menu-foot">
          <a
            voltButton
            class="primary-action"
            [href]="links.gettingStarted"
            target="_blank"
            rel="noopener noreferrer"
            moveWhileTap="press"
            >Read the docs <lmn-arrow-up-right [size]="16"
          /></a>
          <a
            voltButton
            variant="outline"
            [href]="links.github"
            target="_blank"
            rel="noopener noreferrer"
            moveWhileTap="press"
            ><lmn-github [size]="16" />GitHub</a
          >
        </div>
      </div>
    </ng-template>`,
})
export class SiteHeaderComponent {
  protected readonly links = SITE_LINKS;
  protected readonly sections = SECTION_LINKS;
  protected readonly menuOpen = signal(false);
  protected readonly scrolled = signal(false);
  protected readonly active = signal<string | null>(null);

  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    afterNextRender(() => this.watchScroll());
  }

  private watchScroll(): void {
    const view = this.document.defaultView;
    if (!view) return;

    const onScroll = () => {
      const scrolled = view.scrollY > 8;
      if (scrolled !== this.scrolled()) this.zone.run(() => this.scrolled.set(scrolled));
    };
    this.zone.runOutsideAngular(() => view.addEventListener("scroll", onScroll, { passive: true }));
    onScroll();
    this.destroyRef.onDestroy(() => view.removeEventListener("scroll", onScroll));

    if (typeof view.IntersectionObserver !== "function") return;
    // A section is "current" while it crosses a band just under the header.
    const visible = new Set<string>();
    const observer = new view.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const current = this.sections.find((section) => visible.has(section.id))?.id ?? null;
        this.zone.run(() => this.active.set(current));
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const section of this.sections) {
      const element = this.document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    this.destroyRef.onDestroy(() => observer.disconnect());
  }
}
