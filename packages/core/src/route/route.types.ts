export type HttpMethod = "GET";

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: string;
}
