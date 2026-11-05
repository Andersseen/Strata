import { getRequestHeader, setResponseHeader } from "h3";
import type { H3Event } from "h3";
import { defineNitroPlugin } from "nitropack/runtime";

import {
  closeReadObservation,
  discardReadObservation,
  openReadObservation,
  READ_OBSERVATION_HEADER,
  READ_RECEIPT_HEADER,
} from "../strata/tenant-authorization";
import type { ReadLedger } from "../strata/tenant-authorization";

/**
 * TEST-ONLY: binds each opted-in request's repository-read ledger to that request's own response
 * (see tenant-authorization.ts). Uses only Nitro's documented runtime hooks: `request` runs before
 * any route, controller or SSR handler; `beforeResponse` runs after the handler produced its body
 * and before h3 writes it, for controller `Response`s, native routes and SSR documents alike.
 */
const ledgerOf = (event: H3Event): ReadLedger | undefined =>
  event.context["fixtureReadLedger"] as ReadLedger | undefined;

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("request", (event) => {
    const ledger = openReadObservation(getRequestHeader(event, READ_OBSERVATION_HEADER));
    if (ledger) event.context["fixtureReadLedger"] = ledger;
  });
  nitroApp.hooks.hook("beforeResponse", (event) => {
    const ledger = ledgerOf(event);
    if (!ledger) return;
    event.context["fixtureReadLedger"] = undefined;
    setResponseHeader(event, READ_RECEIPT_HEADER, closeReadObservation(ledger));
  });
  // A response that never reached `beforeResponse` (an error page) carries no receipt, which the
  // verifier treats as a failure; only release the ledger here.
  nitroApp.hooks.hook("afterResponse", (event) => {
    const ledger = ledgerOf(event);
    if (ledger) discardReadObservation(ledger);
  });
  nitroApp.hooks.hook("error", (_error, { event }) => {
    const ledger = event ? ledgerOf(event) : undefined;
    if (ledger) discardReadObservation(ledger);
  });
});
