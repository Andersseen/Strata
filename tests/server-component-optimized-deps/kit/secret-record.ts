import "@strata-sc/server-components/server-only";

export interface SecretRecord {
  readonly value: string;
}
export const SERVER_ONLY_MARK = "STRATA_FIXTURE_SERVER_ONLY";
