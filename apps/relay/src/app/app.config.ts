import { provideFileRouter } from "@analogjs/router";
import { Directionality } from "@angular/cdk/bidi";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";
import { provideVoltTheme } from "@voltui/components";

export const appConfig: ApplicationConfig = {
  providers: [
    provideFileRouter(),
    provideClientHydration(),
    provideVoltTheme({ dark: true }),
    { provide: Directionality, useFactory: () => new Directionality() },
  ],
};
