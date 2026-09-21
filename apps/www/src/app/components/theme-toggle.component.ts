import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { LmnMoonIcon } from "lumen-icons/moon";
import { LmnSunIcon } from "lumen-icons/sun";

import { ThemeService } from "../theme.service";

@Component({
  selector: "strata-theme-toggle",
  imports: [LmnMoonIcon, LmnSunIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
    class="theme-toggle"
    type="button"
    (click)="theme.toggle()"
    [attr.aria-label]="label()"
  >
    @if (theme.theme() === "dark") {
      <lmn-moon [size]="16" />
    } @else {
      <lmn-sun [size]="16" />
    }
    <span>{{ theme.theme() === "dark" ? "Dark" : "Light" }}</span>
  </button>`,
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);
  protected label = () =>
    this.theme.theme() === "dark" ? "Switch to light theme" : "Switch to dark theme";
}
