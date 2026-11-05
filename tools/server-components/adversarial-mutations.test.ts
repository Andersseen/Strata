import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it } from "vitest";

import {
  AUTHORIZATION_MUTATION,
  BROWSER_CONFIDENTIALITY_MUTATION,
  DATA_SUBSTITUTION_MUTATION,
  READ_BEFORE_AUTHORIZATION_MUTATION,
  applySourceMutation,
  classifyMutationRun,
  cleanupTemporaryDirectory,
  copyAndMutateFixture,
  digestSource,
} from "./lib/adversarial-mutations.ts";
import { packageTreeValidationRoot } from "./lib/full-stack-install.ts";

const roots: string[] = [];
const fixture = (source: string): string => {
  const root = mkdtempSync(join(tmpdir(), "strata-mutation-unit-"));
  roots.push(root);
  const path = join(root, "source.ts");
  writeFileSync(path, source);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) cleanupTemporaryDirectory(root);
});

describe("adversarial source mutations", () => {
  it("validates npm's file-tarball dependency tree at its retained install root", () => {
    assert.equal(
      packageTreeValidationRoot("/tmp/mutated/consumer", "/tmp/healthy-seed"),
      "/tmp/healthy-seed/consumer",
    );
    assert.equal(packageTreeValidationRoot("/tmp/healthy/consumer"), "/tmp/healthy/consumer");
  });

  it("changes exactly the intended source and produces distinct digests", () => {
    const digests = [
      AUTHORIZATION_MUTATION,
      DATA_SUBSTITUTION_MUTATION,
      BROWSER_CONFIDENTIALITY_MUTATION,
      READ_BEFORE_AUTHORIZATION_MUTATION,
    ].map((mutation) => {
      const root = fixture(`before\n${mutation.before}\nafter\n`);
      const digest = applySourceMutation(root, { ...mutation, path: "source.ts" });
      assert.equal(
        readFileSync(join(root, "source.ts"), "utf8"),
        `before\n${mutation.after}\nafter\n`,
      );
      assert.notEqual(digest, digestSource(`before\n${mutation.before}\nafter\n`));
      return digest;
    });
    assert.equal(new Set(digests).size, digests.length);
  });

  it("each mutation has exactly one pristine target in the real full-stack fixture", () => {
    const fixtureRoot = new URL(
      "../../tests/full-stack-package-consumer/fixture/",
      import.meta.url,
    );
    for (const mutation of [
      AUTHORIZATION_MUTATION,
      DATA_SUBSTITUTION_MUTATION,
      BROWSER_CONFIDENTIALITY_MUTATION,
      READ_BEFORE_AUTHORIZATION_MUTATION,
    ]) {
      const source = readFileSync(new URL(mutation.path, fixtureRoot), "utf8");
      assert.equal(source.split(mutation.before).length - 1, 1, mutation.name);
    }
  });

  it("rejects unknown, ambiguous, and already-mutated targets", () => {
    const missing = fixture("some source\n");
    assert.throws(
      () => applySourceMutation(missing, { ...AUTHORIZATION_MUTATION, path: "source.ts" }),
      /found 0/,
    );
    const ambiguous = fixture(
      `${AUTHORIZATION_MUTATION.before}\n${AUTHORIZATION_MUTATION.before}\n`,
    );
    assert.throws(
      () => applySourceMutation(ambiguous, { ...AUTHORIZATION_MUTATION, path: "source.ts" }),
      /found 2/,
    );
    const mutated = fixture(`${AUTHORIZATION_MUTATION.after}\n`);
    assert.throws(
      () => applySourceMutation(mutated, { ...AUTHORIZATION_MUTATION, path: "source.ts" }),
      /found 0/,
    );
  });

  it("keeps the healthy fixture source pristine", () => {
    const healthy = readFileSync(
      new URL(
        "../../tests/full-stack-package-consumer/fixture/src/server/strata/tenant-authorization.ts",
        import.meta.url,
      ),
      "utf8",
    );
    assert.ok(healthy.includes(AUTHORIZATION_MUTATION.before));
    assert.ok(!healthy.includes(AUTHORIZATION_MUTATION.after));
  });

  it("mutates only a copied fixture and keeps the original byte-identical", () => {
    const source = fixture(AUTHORIZATION_MUTATION.before);
    const destinationRoot = fixture("destination");
    const target = join(source, "source.ts");
    const destination = join(destinationRoot, "consumer-copy");
    const original = readFileSync(target);
    const digest = copyAndMutateFixture(source, destination, {
      ...AUTHORIZATION_MUTATION,
      path: "source.ts",
    });

    assert.equal(readFileSync(target).compare(original), 0);
    assert.equal(
      readFileSync(join(destination, "source.ts"), "utf8"),
      AUTHORIZATION_MUTATION.after,
    );
    assert.equal(digest, digestSource(AUTHORIZATION_MUTATION.after));
  });

  it("accepts only the specific checker rejection after the production runtime paths", () => {
    const sourceDigest = "source-digest";
    const expectedFailure = "authorization verifier observed unsafe response";
    const transcript = [
      `adversarial source digest: ${sourceDigest}`,
      "ok   external packed-package installation",
      "ok   TypeScript 6: declaration examples plus actual authorization helper/controller/SSR source",
      "ok   TypeScript 5.9: declaration examples plus actual authorization helper/controller/SSR source",
      "ok   consumer `vite build` exits 0",
      "node: GET /api/products/42 → 200 JSON",
      "workerd: GET /api/products/42 → 200 JSON",
      "node: before any script the server HTML is visible with the initial state",
      "workerd: before any script the server HTML is visible with the initial state",
      ` FAIL Node: ${expectedFailure} — {"status":200}`,
    ].join("\n");

    assert.deepEqual(
      classifyMutationRun({ status: 1, transcript, expectedFailure, sourceDigest }),
      {
        accepted: true,
        rejection: ` FAIL Node: ${expectedFailure} — {"status":200}`,
        reasons: [],
      },
    );
  });

  it("does not treat install, build, startup, or unrelated assertion failures as a security rejection", () => {
    const common = [
      "adversarial source digest: source-digest",
      "ok   external packed-package installation",
      "ok   TypeScript 6: declaration examples plus actual authorization helper/controller/SSR source",
      "ok   TypeScript 5.9.2: declaration examples plus actual authorization helper/controller/SSR source",
      "ok   consumer `vite build` exits 0",
      "node: GET /api/products/42 → 200 JSON",
      "workerd: GET /api/products/42 → 200 JSON",
      "node: before any script the server HTML is visible with the initial state",
      "workerd: before any script the server HTML is visible with the initial state",
    ].join("\n");
    const expectedFailure = "authorization verifier observed unsafe response";
    const classify = (transcript: string) =>
      classifyMutationRun({
        status: 1,
        transcript,
        expectedFailure,
        sourceDigest: "source-digest",
      });

    assert.equal(classify(`${common}\n FAIL npm install exits 0`).accepted, false);
    assert.equal(classify(`${common}\n FAIL server startup`).accepted, false);
    assert.equal(
      classify(`${common}\n FAIL ${expectedFailure} — status=200\n FAIL start production server`)
        .accepted,
      false,
    );
    assert.match(
      classify(`${common}\n FAIL unrelated graph assertion`).reasons.join("; "),
      /expected checker rejection/,
    );
  });

  it("requires a positive browser artifact control for confidentiality mutations", () => {
    const transcript = [
      "adversarial source digest: marker-digest",
      "ok   external packed-package installation",
      "ok   TypeScript 6: declaration examples plus actual authorization helper/controller/SSR source",
      "ok   TypeScript 5.9.2: declaration examples plus actual authorization helper/controller/SSR source",
      "ok   consumer `vite build` exits 0",
      "node: GET /api/products/42 → 200 JSON",
      "workerd: GET /api/products/42 → 200 JSON",
      "node: before any script the server HTML is visible with the initial state",
      "workerd: before any script the server HTML is visible with the initial state",
      " FAIL marker absent from browser output",
    ].join("\n");
    const verdict = classifyMutationRun({
      status: 1,
      transcript,
      expectedFailure: "marker absent from browser output",
      sourceDigest: "marker-digest",
      expectedMarker: "PRIVATE_MARKER",
      markerInBrowserArtifact: false,
    });

    assert.equal(verdict.accepted, false);
    assert.match(verdict.reasons.join("; "), /not proven present/);
  });

  it("cleans temporary consumers after both successful and failed scenarios", () => {
    const success = fixture("ok");
    cleanupTemporaryDirectory(success);
    assert.throws(() => readFileSync(success), /ENOENT/);

    const failure = fixture("throw");
    assert.throws(() => {
      try {
        throw new Error("simulated unexpected build failure");
      } finally {
        cleanupTemporaryDirectory(failure);
      }
    }, /simulated unexpected build failure/);
    assert.throws(() => readFileSync(failure), /ENOENT/);
  });
});
