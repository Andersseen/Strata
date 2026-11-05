import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { parseReadReceipt, readObservationsMatch } from "./lib/full-stack-verify.ts";

const A = "0b5e8a1c-3f0e-4a8e-9d55-2c4b7f1e9a01";
const B = "7d1c2e44-90ab-4cde-8f01-23456789abcd";

describe("invocation-owned read receipts (F6)", () => {
  it("parses only a consistent receipt for the requesting observation id", () => {
    assert.deepEqual(parseReadReceipt(`${A};reads=1;resources=alpha-product`, A), {
      id: A,
      resources: ["alpha-product"],
    });
    assert.deepEqual(parseReadReceipt(`${A};reads=0;resources=`, A), { id: A, resources: [] });
    // Another request's receipt, a missing receipt, an inconsistent count, a conflicting id.
    assert.equal(parseReadReceipt(`${B};reads=0;resources=`, A), undefined);
    assert.equal(parseReadReceipt(null, A), undefined);
    assert.equal(parseReadReceipt(`${A};reads=0;resources=alpha-product`, A), undefined);
    assert.equal(parseReadReceipt(`${A};reads=0;resources=;conflict`, A), undefined);
  });

  it("requires one owner read when authorized and none when denied", () => {
    const authorized = { id: A, receipt: `${A};reads=1;resources=alpha-product` };
    const denied = { id: B, receipt: `${B};reads=0;resources=` };
    assert.equal(readObservationsMatch([authorized, denied], [["alpha-product"], []]), true);
    // A denied response that read (read-before-deny), and a cross-tenant read.
    assert.equal(
      readObservationsMatch(
        [authorized, { id: B, receipt: `${B};reads=1;resources=alpha-product` }],
        [["alpha-product"], []],
      ),
      false,
    );
    assert.equal(
      readObservationsMatch(
        [{ id: A, receipt: `${A};reads=1;resources=beta-product` }],
        [["alpha-product"]],
      ),
      false,
    );
    // An HTTP 200 alone is not proof: no recorded read, or two reads, fails.
    assert.equal(
      readObservationsMatch([{ id: A, receipt: `${A};reads=0;resources=` }], [["alpha-product"]]),
      false,
    );
    assert.equal(
      readObservationsMatch(
        [{ id: A, receipt: `${A};reads=2;resources=alpha-product,alpha-product` }],
        [["alpha-product"]],
      ),
      false,
    );
  });

  it("treats a missing receipt as a failure, never as zero reads", () => {
    assert.equal(readObservationsMatch([{ id: B, receipt: null }], [[]]), false);
    assert.equal(readObservationsMatch([], [[]]), false);
  });
});
