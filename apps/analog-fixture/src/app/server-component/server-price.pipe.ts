import { Pipe } from "@angular/core";
import type { PipeTransform } from "@angular/core";

import { fingerprint } from "./product-repository";

// Emitted only by this pipe. The server component imports it without marking
// it as a client boundary, so it must stay in the server graph.
const SERVER_ONLY_IMPORT_MARKER = "STRATA_SERVER_ONLY_IMPORT_MARKER";

/** A server-only pipe: an Angular import of the server component that is not client-side. */
@Pipe({ name: "serverPrice" })
export class ServerPricePipe implements PipeTransform {
  transform(productId: string): string {
    return `${productId}.${fingerprint(SERVER_ONLY_IMPORT_MARKER)}`;
  }
}
