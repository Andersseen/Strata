// Shared on purpose: imported by the server-only ProductRepository and by the
// AddToCart client island. An ordinary import from a server-only module does
// not make this module server-only, so it must reach both graphs.
const SHARED_FORMAT_MARKER = "STRATA_SHARED_FORMAT_MARKER";

/** Appends a runtime hash of the marker, so no bundler can fold it away. */
export function formatShared(value: string): string {
  let hash = 0;

  for (let index = 0; index < SHARED_FORMAT_MARKER.length; index++) {
    hash = (Math.imul(hash, 31) + SHARED_FORMAT_MARKER.charCodeAt(index)) | 0;
  }

  return `${value}.${(hash >>> 0).toString(16)}`;
}
