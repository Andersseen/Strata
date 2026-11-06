import { provideContent, withMarkdownRenderer } from "@analogjs/content";
import { provideFileRouter, withExtraRoutes } from "@analogjs/router";
import { Directionality } from "@angular/cdk/bidi";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";
import { defineDoqConfig, doqRoutes, provideDoq } from "@doqs/analog";
import { provideVoltTheme } from "@voltui/components";

import { doqPaths } from "../doq.paths";

const doqConfig = defineDoqConfig({
  ...doqPaths,
  presentation: {
    documentationLabel: "Docs",
    indexTitle: "Strata documentation",
    indexDescription: "Guides and reference for Strata's Angular and Analog packages.",
    pageTitleSuffix: "Strata",
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideFileRouter(withExtraRoutes(doqRoutes(doqConfig))),
    provideContent(withMarkdownRenderer()),
    provideDoq(doqConfig),
    provideClientHydration(),
    provideVoltTheme({ dark: true }),
    // Volt's navigation primitives resolve CDK directionality during SSR. This
    // explicit factory keeps that construction inside Angular's injection context.
    { provide: Directionality, useFactory: () => new Directionality() },
  ],
};
