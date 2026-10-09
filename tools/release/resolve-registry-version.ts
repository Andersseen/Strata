import { readFileSync } from "node:fs";

import { resolveRegistryVersion } from "./lib/registry-version.ts";

/**
 * Prints the exact version a registry verification should target.
 *
 *   node --experimental-strip-types tools/release/resolve-registry-version.ts [version]
 *
 * With no argument (or an empty one) it reads packages/server-components/package.json.
 */
const manifest = JSON.parse(
  readFileSync(new URL("../../packages/server-components/package.json", import.meta.url), "utf8"),
) as { version: string };

try {
  console.log(resolveRegistryVersion(process.argv[2], manifest.version));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
