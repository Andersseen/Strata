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
import { VoltNativeButton } from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnArrowUpIcon } from "lumen-icons/arrow-up";

/** Appears once the hero has scrolled away; returns to the top of the page. */
@Component({
  selector: "strata-back-to-top",
  imports: [...MOVEMENT_DIRECTIVES, LmnArrowUpIcon, VoltNativeButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-container *movePresence="visible()">
    <button
      voltButton
      variant="outline"
      size="icon"
      type="button"
      class="back-to-top"
      aria-label="Back to top"
      [moveInitial]="{ opacity: 0, y: 14, scale: 0.92 }"
      [moveAnimate]="{ opacity: 1, y: 0, scale: 1 }"
      [moveExit]="{ opacity: 0, y: 14, scale: 0.92 }"
      moveDuration="260"
      moveWhileTap="press"
      (click)="toTop()"
    >
      <lmn-arrow-up [size]="16" />
    </button>
  </ng-container>`,
})
export class BackToTopComponent {
  protected readonly visible = signal(false);
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    afterNextRender(() => {
      const view = this.document.defaultView;
      if (!view) return;
      const onScroll = () => {
        const visible = view.scrollY > view.innerHeight * 0.9;
        if (visible !== this.visible()) this.zone.run(() => this.visible.set(visible));
      };
      this.zone.runOutsideAngular(() =>
        view.addEventListener("scroll", onScroll, { passive: true }),
      );
      onScroll();
      this.destroyRef.onDestroy(() => view.removeEventListener("scroll", onScroll));
    });
  }

  protected toTop(): void {
    const view = this.document.defaultView;
    const reduce = view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    view?.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    this.document.querySelector<HTMLElement>(".brand")?.focus({ preventScroll: true });
  }
}
