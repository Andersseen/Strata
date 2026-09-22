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
    // Volt's navigation primitives resolve CDK directionality during SSR. This
    // explicit factory keeps that construction inside Angular's injection context.
    { provide: Directionality, useFactory: () => new Directionality() },
  ],
};
