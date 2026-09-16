import type { RouteDefinition } from "../route/route.types.js";

export interface ControllerDefinition {
  readonly path: string;
  readonly routes: readonly RouteDefinition[];
}
