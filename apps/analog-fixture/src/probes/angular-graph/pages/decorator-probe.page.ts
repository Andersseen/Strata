import { Component } from "@angular/core";
import { getControllerDefinition } from "@strata/core";

import { ProbeController } from "../probe.controller";

@Component({
  selector: "app-decorator-probe",
  template: `<pre id="strata-probe">{{ definition }}</pre>`,
})
export default class DecoratorProbe {
  protected readonly definition = JSON.stringify(getControllerDefinition(ProbeController));
}
