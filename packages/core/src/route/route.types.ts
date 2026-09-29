export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: string;
}
