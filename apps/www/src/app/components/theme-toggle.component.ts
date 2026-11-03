import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { VoltNativeButton } from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnMoonIcon } from "lumen-icons/moon";
import { LmnSunIcon } from "lumen-icons/sun";

import { ThemeService } from "../theme.service";

@Component({
  selector: "strata-theme-toggle",
  imports: [...MOVEMENT_DIRECTIVES, LmnMoonIcon, LmnSunIcon, VoltNativeButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
    voltButton
    variant="outline"
    size="icon"
    class="theme-toggle"
    type="button"
    moveWhileTap="press"
    (click)="theme.toggle()"
    [attr.aria-label]="label()"
  >
    @if (theme.theme() === "dark") {
      <lmn-moon [size]="16" move="icon-pulse" />
    } @else {
      <lmn-sun [size]="16" move="icon-pulse" />
    }
  </button>`,
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);
  protected label = () =>
    this.theme.theme() === "dark" ? "Switch to light theme" : "Switch to dark theme";
}
