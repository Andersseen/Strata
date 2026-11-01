import { ChangeDetectionStrategy, Component, Directive, input } from "@angular/core";

/*
 * Controlled invalid package exports for the installed-island reference matrix. Every export is a
 * legitimate, partially compiled Angular declaration; each one is only invalid in the position the
 * consumer registers it in.
 */

/** A valid standalone component, but its selector is not the one a registration would claim. */
@Component({
  selector: "acme-mismatched-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-package-negative="mismatched">mismatched</p>`,
})
export class MismatchedPickerComponent {}

/** A second, distinct component that claims the selector of `ProductPickerComponent`. */
@Component({
  selector: "acme-product-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-package-negative="duplicate">{{ productView().name }}</p>`,
})
export class DuplicatePickerComponent {
  readonly productView = input.required<{ readonly name: string }>();
}

/** A directive: reflects to no component and must never be accepted as a client island. */
@Directive({ selector: "acme-directive-only", standalone: true })
export class DirectiveOnlyDirective {}

/** A class without any Angular metadata. */
export class PlainClass {}

/** Not a class at all. */
export const NOT_A_CLASS = 42;
