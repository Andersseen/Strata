import "@strata-sc/server-components/server-only";
import { PRIVATE_IMPL } from "./internal/impl.js";
export const SERVER_ONLY_MARK = "STRATA_FIXTURE_SERVER_ONLY";
export const reveal = () => `${SERVER_ONLY_MARK}:${PRIVATE_IMPL}`;
