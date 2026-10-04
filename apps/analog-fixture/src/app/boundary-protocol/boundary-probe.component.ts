import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
} from "@angular/core";

/**
 * Client island that reports, on click, the exact values its inputs received
 * in the browser (and their JSON types). `caption` is aliased: the boundary
 * prop is its public name, `label`.
 *
 * Fixture-only failure injection for the commit-rollback check: a browser
 * test may set `globalThis.__STRATA_BOUNDARY_FAIL__` to a host's `data-probe`
 * value before scripts run, and that island's constructor throws. Unset
 * everywhere else, including SSR.
 */
@Component({
  selector: "boundary-probe",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-field="text">{{ text() }}</p>
    <button type="button" (click)="report()">Report {{ caption() }}</button>
    <output>{{ reported() }}</output>`,
})
export class BoundaryProbeComponent {
  readonly text = input.required<string>();
  readonly count = input.required<number>();
  readonly enabled = input.required<boolean>();
  readonly empty = input.required<null>();
  readonly caption = input.required<string>({ alias: "label" });

  protected readonly reported = signal("");

  constructor() {
    const probe = (inject(ElementRef).nativeElement as Element).getAttribute("data-probe");
    const fail = (globalThis as { __STRATA_BOUNDARY_FAIL__?: string }).__STRATA_BOUNDARY_FAIL__;

    if (probe !== null && fail === probe) {
      throw new Error(
        `[fixture] injected island failure for <boundary-probe data-probe="${probe}">`,
      );
    }
  }

  protected report(): void {
    this.reported.set(
      JSON.stringify({
        label: this.caption(),
        text: this.text(),
        count: this.count(),
        enabled: this.enabled(),
        empty: this.empty(),
      }),
    );
  }
}
