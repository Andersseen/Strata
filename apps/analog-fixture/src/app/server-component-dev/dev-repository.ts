import "@strata-sc/server-components/server-only";

// A synthetic canary, not a secret: the Server Component below executes this
// module during SSR, and no browser response may ever contain it.
const DEV_REPOSITORY_CANARY = "STRATA_DEV_REPOSITORY_CANARY_93A4D7B1E605";

/** Only a hash of the canary crosses to the page. */
export function readDevRepository(): string {
  let hash = 0;

  for (let index = 0; index < DEV_REPOSITORY_CANARY.length; index++) {
    hash = (Math.imul(hash, 31) + DEV_REPOSITORY_CANARY.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(16);
}
