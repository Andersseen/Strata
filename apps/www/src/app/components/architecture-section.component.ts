import { ChangeDetectionStrategy, Component } from "@angular/core";
import { VoltCard, VoltCardContent } from "@voltui/components";
import { MOVEMENT_DIRECTIVES } from "angular-movement";
import { LmnCheckCircleIcon } from "lumen-icons/check-circle";

@Component({
  selector: "strata-architecture-section",
  imports: [...MOVEMENT_DIRECTIVES, LmnCheckCircleIcon, VoltCard, VoltCardContent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section id="architecture" class="architecture-section section-wrap">
    <div
      class="architecture-copy"
      [moveInView]="{ opacity: [0, 1], x: [-24, 0] }"
      moveInViewOnce="true"
    >
      <p class="eyebrow">TWO AXES, CLEAR OWNERSHIP</p>
      <h2>Strata never replaces your server.</h2>
      <p>
        It owns two precise seams: which parts of the UI graph stay on the server, and how
        controllers register on the router you already have. Angular, Analog and Nitro keep their
        lifecycles.
      </p>
      <ul>
        <li>
          <lmn-check-circle [size]="16" />UI graph: Server Components and their dependencies stay
          server-side
        </li>
        <li><lmn-check-circle [size]="16" />Client boundaries are the only UI that hydrates</li>
        <li>
          <lmn-check-circle [size]="16" />Controllers register on Nitro/H3; native routes stay
        </li>
      </ul>
    </div>
    <div
      class="ownership-list"
      role="list"
      aria-label="How an Angular application splits across Strata"
      [moveInView]="{ opacity: [0, 1], x: [24, 0] }"
      moveInViewOnce="true"
    >
      <volt-card role="listitem"
        ><volt-card-content
          ><span>01</span><b>Angular application</b
          ><small>Components, routes and domain logic</small></volt-card-content
        ></volt-card
      >
      <volt-card role="listitem" class="ownership-branch"
        ><volt-card-content
          ><span>├─</span><b>Server Component</b
          ><small>Rendered on the server · server graph</small></volt-card-content
        ></volt-card
      >
      <volt-card role="listitem" class="ownership-leaf"
        ><volt-card-content
          ><span>│ ├─</span><b>Server dependency</b
          ><small>Repositories, secrets · never shipped</small></volt-card-content
        ></volt-card
      >
      <volt-card role="listitem" class="ownership-leaf ownership-client"
        ><volt-card-content
          ><span>│ └─</span><b>Client boundary</b
          ><small>Hydrated in the browser · plain-data props</small></volt-card-content
        ></volt-card
      >
      <volt-card role="listitem" class="ownership-branch"
        ><volt-card-content
          ><span>└─</span><b>Controller</b><small>HTTP routes as metadata</small></volt-card-content
        ></volt-card
      >
      <volt-card role="listitem" class="ownership-runtime"
        ><volt-card-content>
          <span>↓</span><b>Analog / Nitro / H3</b><small>Your owned request lifecycle</small>
        </volt-card-content></volt-card
      >
    </div>
  </section>`,
})
export class ArchitectureSectionComponent {}
