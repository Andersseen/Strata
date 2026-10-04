import { ChangeDetectionStrategy, Component } from "@angular/core";

import { BoundaryInvalidServerComponent } from "../boundary-protocol/boundary-invalid.server-component";

/** Negative fixture page: its SSR must fail (see BoundaryInvalidServerComponent). */
@Component({
  selector: "app-server-component-boundary-invalid-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoundaryInvalidServerComponent],
  template: `<main><boundary-invalid /></main>`,
})
export default class ServerComponentBoundaryInvalidPage {}
