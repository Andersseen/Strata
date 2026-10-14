export type RequestContextIdentity = "alpha" | "beta";

export interface RequestContextFixtureValue {
  readonly id: RequestContextIdentity;
  readonly round: string;
  readonly operation: "read" | "fail";
}
