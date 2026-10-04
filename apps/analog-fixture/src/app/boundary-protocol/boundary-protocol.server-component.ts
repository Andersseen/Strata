import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { BoundaryCounterComponent } from "./boundary-counter.component";
import { BoundaryProbeComponent } from "./boundary-probe.component";
import { ADVERSARIAL_TEXT, PRIMITIVES } from "./boundary-values";

/**
 * Client boundary protocol fixture (`pnpm test:server-components`). Four
 * boundaries under one Server Component host: two identical counters (same
 * selector, same props, independent state), a probe of every primitive plus
 * an aliased input, and a probe of adversarial and non-Latin strings.
 */
@ServerComponent()
@Component({
  selector: "boundary-protocol",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoundaryCounterComponent, BoundaryProbeComponent, StrataClientBoundary],
  template: `<section>
    <h1>Boundary protocol</h1>
    <boundary-counter data-counter="A" [start]="0" [strataClient]="{ start: 0 }" />
    <boundary-counter data-counter="B" [start]="0" [strataClient]="{ start: 0 }" />
    <boundary-probe
      data-probe="primitives"
      [label]="'primitives'"
      [text]="primitives.text"
      [count]="primitives.count"
      [enabled]="primitives.enabled"
      [empty]="primitives.empty"
      [strataClient]="{
        label: 'primitives',
        text: primitives.text,
        count: primitives.count,
        enabled: primitives.enabled,
        empty: primitives.empty
      }"
    />
    <boundary-probe
      data-probe="escaping"
      [label]="'escaping'"
      [text]="adversarial"
      [count]="-1.5"
      [enabled]="false"
      [empty]="null"
      [strataClient]="{
        label: 'escaping',
        text: adversarial,
        count: -1.5,
        enabled: false,
        empty: null
      }"
    />
  </section>`,
})
export class BoundaryProtocolServerComponent {
  protected readonly primitives = PRIMITIVES;
  protected readonly adversarial = ADVERSARIAL_TEXT;
}
