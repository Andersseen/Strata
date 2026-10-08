/**
 * What the packed-package consumer fixture (tests/server-component-package-consumer/fixture)
 * emits, shared by the tarball qualification and the registry consumer: the
 * server/client markers, the consumer-authored server sources, and the
 * server-computed evidence the SSR HTML must carry.
 */

export const MARKERS = {
  server: "EXTERNAL_CONSUMER_SERVER_MARKER",
  transitive: "EXTERNAL_CONSUMER_TRANSITIVE_MARKER",
  implementation: "EXTERNAL_CONSUMER_IMPLEMENTATION_MARKER",
  client: "EXTERNAL_CONSUMER_CLIENT_MARKER",
} as const;
export const SERVER_MARKERS = [MARKERS.server, MARKERS.transitive, MARKERS.implementation] as const;

/** Consumer-authored files that must never reach the browser graph or its maps. */
export const SERVER_SOURCES = [
  "product.repository.ts",
  "server-helper.ts",
  "product-details.server-component.ts",
] as const;

export const SERVER_MESSAGE_A = "External server A";
export const SERVER_MESSAGE_B = "External server B";

/** Same hash as the fixture's `fingerprint`, to predict the server-computed evidence. */
export function fingerprint(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(16);
}

export const EXPECTED_EVIDENCE = `${fingerprint(MARKERS.implementation)}.${fingerprint(MARKERS.server)}.${fingerprint(MARKERS.transitive)}`;
