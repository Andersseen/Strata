export { Controller } from "./controller/controller.decorator.js";
export { getControllerDefinition } from "./controller/get-controller-definition.js";
export type { ControllerDefinition } from "./controller/controller.types.js";
export { Delete, Get, Patch, Post, Put } from "./route/http-method.decorators.js";
export type { HttpMethod, RouteDefinition } from "./route/route.types.js";

/** Inlined from package.json at build time (see vite.config.ts). */
declare const __STRATA_VERSION__: string;

export const STRATA_VERSION: string = __STRATA_VERSION__;
