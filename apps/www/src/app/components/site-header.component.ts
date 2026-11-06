import { isPlatformBrowser } from "@angular/common";
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  inject,
  Injector,
  NgZone,
  PLATFORM_ID,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { NavigationEnd, Router } from "@angular/router";
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

/** How far down the viewport a section must start to count as the one being read. */
const SECTION_LINE = 0.35;

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
        <a class="brand" href="/" aria-label="Strata home"
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
                  [href]="'/#' + link.id"
                  [active]="active() === link.id"
                  >{{ link.label }}</a
                ></volt-navigation-menu-item
              >
            }
            <volt-navigation-menu-item
              ><a voltNavigationMenuLink [href]="links.docs" [active]="onDocs()"
                >Docs</a
              ></volt-navigation-menu-item
            >
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
                  [href]="'/#' + link.id"
                  [active]="active() === link.id"
                  (click)="close()"
                  >{{ link.label }}</a
                ></volt-navigation-menu-item
              >
            }
            <volt-navigation-menu-item move="fade-left"
              ><a voltNavigationMenuLink [href]="links.docs" [active]="onDocs()" (click)="close()"
                >Docs</a
              ></volt-navigation-menu-item
            >
          </volt-navigation-menu-list>
        </volt-navigation-menu>
        <div class="mobile-menu-foot">
          <a voltButton class="primary-action" [href]="links.gettingStarted" moveWhileTap="press"
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
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly url = signal(this.router.url);

  protected readonly onDocs = computed(() => /^\/docs(\/|$|[?#])/.test(this.url()));

  constructor() {
    const browser = isPlatformBrowser(inject(PLATFORM_ID));

    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      this.url.set(event.urlAfterRedirects);
      // The sections belong to the routed page, which renders after this shell.
      if (browser) afterNextRender(() => this.updateActive(), { injector: this.injector });
    });

    if (browser) afterNextRender(() => this.watchScroll());
  }

  /**
   * The current section is the last one whose top has passed a line under the header, so the
   * parts of a section without a link of their own still count as that section. Looked up on every
   * update because the page, and therefore its sections, can change under this shell.
   */
  private updateActive(): void {
    const view = this.document.defaultView;
    if (!view) return;

    const line = view.innerHeight * SECTION_LINE;
    const atEnd = view.innerHeight + view.scrollY >= this.document.documentElement.scrollHeight - 2;
    const present = this.sections.filter(({ id }) => this.document.getElementById(id));
    const passed = present.filter(
      ({ id }) => this.document.getElementById(id)!.getBoundingClientRect().top <= line,
    );
    const current = (atEnd ? present : passed).at(-1)?.id ?? null;

    if (current !== this.active()) this.zone.run(() => this.active.set(current));
  }

  private watchScroll(): void {
    const view = this.document.defaultView;
    if (!view) return;

    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const scrolled = view.scrollY > 8;
      if (scrolled !== this.scrolled()) this.zone.run(() => this.scrolled.set(scrolled));
      this.updateActive();
    };
    const onScroll = () => {
      frame ??= view.requestAnimationFrame(update);
    };

    this.zone.runOutsideAngular(() => {
      view.addEventListener("scroll", onScroll, { passive: true });
      view.addEventListener("resize", onScroll, { passive: true });
    });
    update();
    this.destroyRef.onDestroy(() => {
      view.removeEventListener("scroll", onScroll);
      view.removeEventListener("resize", onScroll);
      if (frame !== undefined) view.cancelAnimationFrame(frame);
    });
  }
}
