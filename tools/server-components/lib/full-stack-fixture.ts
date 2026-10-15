import { fingerprint } from "./consumer-fixture.ts";

/**
 * What the full-stack consumer fixture (tests/full-stack-package-consumer/fixture)
 * emits, shared with its runner: the confidential values, the server-only
 * sources, and the values a request must return.
 */

export const FULL_STACK_MARKERS = {
  server: "FULLSTACK_CONSUMER_SERVER_MARKER",
  transitive: "FULLSTACK_CONSUMER_TRANSITIVE_MARKER",
  implementation: "FULLSTACK_CONSUMER_IMPLEMENTATION_MARKER",
  controller: "FULLSTACK_CONTROLLER_CATALOG_MARKER",
  /** The confidential supplier note the repository hashes; it is never rendered. */
  privateNote: "FULLSTACK_PRIVATE_SUPPLIER_CANARY_9f3c",
  client: "FULLSTACK_CONSUMER_CLIENT_MARKER",
} as const;

/** The confidential supplier cost the repository turns into a public tier. */
export const PRIVATE_COST = "7391047";

/** Must appear in the server graph and nowhere a browser can see. */
export const SERVER_ONLY_MARKERS = [
  FULL_STACK_MARKERS.server,
  FULL_STACK_MARKERS.transitive,
  FULL_STACK_MARKERS.implementation,
  FULL_STACK_MARKERS.controller,
  FULL_STACK_MARKERS.privateNote,
] as const;

/** Values that must never reach HTML, props, API JSON, browser files or maps. */
export const PRIVATE_CANARIES = [...SERVER_ONLY_MARKERS, PRIVATE_COST] as const;

/** Consumer-authored server files that must not appear in any browser source map. */
export const FULL_STACK_SERVER_SOURCES = [
  "product.repository.ts",
  "server-helper.ts",
  "product-details.server-component.ts",
  "products.controller.ts",
  "qualification.controller.ts",
  "product-catalog.ts",
  "lifecycle-stats.ts",
] as const;

export const PRODUCT_42 = { id: "42", name: "Product 42", available: true } as const;

export const CONTROLLER_FINGERPRINT = fingerprint(FULL_STACK_MARKERS.controller);

/** The SSR page's `data-evidence`: same arithmetic as the fixture, over server-only values. */
export const EXPECTED_EVIDENCE = [
  fingerprint(FULL_STACK_MARKERS.implementation),
  fingerprint(FULL_STACK_MARKERS.server),
  fingerprint(FULL_STACK_MARKERS.transitive),
  fingerprint(FULL_STACK_MARKERS.privateNote),
].join(".");
