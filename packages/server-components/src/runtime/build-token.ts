import { InjectionToken } from "@angular/core";

import { compiledBuildId } from "./build-identity.js";

/** The identity of this build; a token so that tests and unusual hosts can replace it. */
export const STRATA_BUILD_ID = new InjectionToken<string | undefined>("STRATA_BUILD_ID", {
  providedIn: "root",
  factory: compiledBuildId,
});
