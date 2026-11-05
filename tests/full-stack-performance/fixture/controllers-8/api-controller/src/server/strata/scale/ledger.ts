import type {
  StrataAnalogControllerFactory,
  StrataAnalogGuard,
  StrataAnalogRequest,
} from "@strata-sc/analog";

import { RequestLedger } from "../../scale/domain";
import type { ScaleResource } from "../../scale/domain";

export const SCALE_CONTROLLER_MARKER = "PERF_SCALE_CONTROLLER_MARKER";

const ledgers = new WeakMap<StrataAnalogRequest, RequestLedger>();

/** The request-scoped ledger the factory created for this invocation. */
export function ledgerFor(request: StrataAnalogRequest): RequestLedger {
  const ledger = ledgers.get(request);

  if (!ledger) throw new Error("no ledger for this request");

  return ledger;
}

const resourceOf = (path: string): ScaleResource | undefined =>
  /^\/api\/scale\/(r[1-8])(\/|$)/.exec(path)?.[1] as ScaleResource | undefined;

/** Consumer-owned lifetime: one ledger per scale request, released by Strata's cleanup scope. */
export const scaleFactory: StrataAnalogControllerFactory = (controller, { request, onCleanup }) => {
  const resource = resourceOf(request.path);

  if (resource) {
    const ledger = new RequestLedger(resource);

    ledgers.set(request, ledger);
    onCleanup(() => ledger.release());
  }

  return new controller();
};

/** DELETE is reserved to an administrator role that no benchmark request carries. */
export const scaleGuard: StrataAnalogGuard = ({ route, request }) =>
  route.method === "DELETE" && request.headers.get("x-perf-role") !== "admin"
    ? { allow: false, status: 403 }
    : { allow: true };
