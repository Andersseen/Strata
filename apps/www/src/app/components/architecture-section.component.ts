import { ChangeDetectionStrategy, Component } from "@angular/core";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnCheckCircleIcon } from "lumen-icons/check-circle";

@Component({
  selector: "strata-architecture-section",
  imports: [...MOVEMENT_DIRECTIVES, LmnCheckCircleIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section id="architecture" class="architecture-section section-wrap">
    <div
      class="architecture-copy"
      [moveInView]="{ opacity: [0, 1], x: [-24, 0] }"
      moveInViewOnce="true"
    >
      <p class="eyebrow">CLEAR LAYERS, CLEAR OWNERSHIP</p>
      <h2>Strata never replaces your server.</h2>
      <p>
        It reads controller metadata and registers routes on the instance you pass in. Native routes
        keep working. Your framework continues to own the lifecycle.
      </p>
      <ul>
        <li><lmn-check-circle [size]="16" />H3 remains the HTTP runtime</li>
        <li><lmn-check-circle [size]="16" />Nitro remains the Analog integration point</li>
        <li><lmn-check-circle [size]="16" />Your direct routes remain untouched</li>
      </ul>
    </div>
    <div
      class="ownership-list"
      [moveInView]="{ opacity: [0, 1], x: [24, 0] }"
      moveInViewOnce="true"
    >
      <div><span>01</span><b>Application</b><small>Business logic and controllers</small></div>
      <div><span>02</span><b>Strata core</b><small>Route declarations as metadata</small></div>
      <div><span>03</span><b>Adapter</b><small>A precise registration seam</small></div>
      <div class="ownership-runtime">
        <span>04</span><b>H3 / Nitro</b><small>Your owned request lifecycle</small>
      </div>
    </div>
  </section>`,
})
export class ArchitectureSectionComponent {}
