import { createHash } from "node:crypto";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceMutation {
  readonly name: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface MutationRunEvidence {
  readonly status: number;
  readonly transcript: string;
  readonly expectedFailure: string;
  readonly sourceDigest: string;
  readonly expectedMarker?: string;
  readonly markerInBrowserArtifact?: boolean;
}

export interface MutationRunVerdict {
  readonly accepted: boolean;
  readonly rejection: string | null;
  readonly reasons: readonly string[];
}

export function classifyMutationRun(evidence: MutationRunEvidence): MutationRunVerdict {
  const {
    status,
    transcript,
    expectedFailure,
    sourceDigest,
    expectedMarker,
    markerInBrowserArtifact,
  } = evidence;
  const rejection = transcript
    .split("\n")
    .find((line) => line.includes("FAIL") && line.includes(expectedFailure));
  const reasons: string[] = [];

  if (status === 0) reasons.push("consumer unexpectedly exited successfully");
  if (!rejection) reasons.push(`expected checker rejection was not observed: ${expectedFailure}`);
  if (!transcript.includes(`adversarial source digest: ${sourceDigest}`))
    reasons.push("production consumer did not confirm the intended mutated source digest");
  if (!transcript.includes("ok   external packed-package installation"))
    reasons.push("packed package integrity and installation checks did not pass");
  if (
    !transcript.includes(
      "ok   TypeScript 6: declaration examples plus actual authorization helper/controller/SSR source",
    )
  )
    reasons.push("TypeScript 6 actual-source qualification did not pass");
  if (
    !transcript.includes(
      "ok   TypeScript 5.9: declaration examples plus actual authorization helper/controller/SSR source",
    )
  )
    reasons.push("TypeScript 5.9 actual-source qualification did not pass");
  if (!transcript.includes("ok   consumer `vite build` exits 0"))
    reasons.push("production build did not complete successfully");
  if (!transcript.includes("node: GET /api/products/42 → 200 JSON"))
    reasons.push("Node production HTTP path was not reached");
  if (!transcript.includes("workerd: GET /api/products/42 → 200 JSON"))
    reasons.push("local workerd HTTP path was not reached");
  if (
    !transcript.includes(
      "node: before any script the server HTML is visible with the initial state",
    )
  )
    reasons.push("Node Chromium path was not reached");
  if (
    !transcript.includes(
      "workerd: before any script the server HTML is visible with the initial state",
    )
  )
    reasons.push("workerd Chromium path was not reached");
  if (
    /FAIL (?:consumer `vite build` exits 0|npm install exits 0|TypeScript [56]\.|external packed-package installation|start production server|start wrangler pages dev)|Failed to spawn/i.test(
      transcript,
    )
  )
    reasons.push("an install, production build, or process startup failure occurred");
  if (expectedMarker && !markerInBrowserArtifact)
    reasons.push("the injected marker was not proven present in a browser artifact");

  return { accepted: reasons.length === 0, rejection: rejection ?? null, reasons };
}

export function copyAndMutateFixture(
  sourceRoot: string,
  destination: string,
  mutation: SourceMutation,
): string {
  cpSync(sourceRoot, destination, { recursive: true });

  return applySourceMutation(destination, mutation);
}

export function cleanupTemporaryDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function applySourceMutation(root: string, mutation: SourceMutation): string {
  const path = join(root, mutation.path);
  const source = readFileSync(path, "utf8");
  const occurrences = source.split(mutation.before).length - 1;

  if (occurrences !== 1) {
    throw new Error(
      `${mutation.name}: expected exactly one pristine target in ${mutation.path}, found ${occurrences}`,
    );
  }
  const changed = source.replace(mutation.before, mutation.after);
  if (changed === source) throw new Error(`${mutation.name}: mutation did not change source`);
  writeFileSync(path, changed);

  return createHash("sha256").update(changed).digest("hex");
}

export const digestSource = (source: string): string =>
  createHash("sha256").update(source).digest("hex");

export const AUTHORIZATION_MUTATION: SourceMutation = {
  name: "remove tenant ownership comparison",
  path: "src/server/strata/tenant-authorization.ts",
  before: "return principal.tenant === owner ? 200 : 403;",
  after: "return 200; // intentional adversarial authorization regression",
};

export const DATA_SUBSTITUTION_MUTATION: SourceMutation = {
  name: "substitute beta resource for every protected response",
  path: "src/server/strata/tenant-authorization.ts",
  before: "const tenant = tenantForResource[id];",
  after: 'const tenant = "beta" as Tenant; // intentional cross-tenant substitution',
};

export const BROWSER_CONFIDENTIALITY_MUTATION: SourceMutation = {
  name: "render tenant-private marker in the Angular island",
  path: "src/app/products/product-availability.component.ts",
  before: 'signal("Availability: not checked")',
  after: 'signal("Availability: ALPHA_CONFIDENTIAL_71c1")',
};

/**
 * Reads the private resource in the controller guard BEFORE authorizing. Every response stays a
 * correct status with correct data, so only the invocation-owned read receipt (F6) can reject it.
 */
export const READ_BEFORE_AUTHORIZATION_MUTATION: SourceMutation = {
  name: "read the protected resource before authorization",
  path: "src/server/strata/protected.controller.ts",
  before: "  const status = authorize(resolveTenant(request.headers), owner);",
  after:
    "  readProtectedResource(id, request); // intentional adversarial read before authorization\n  const status = authorize(resolveTenant(request.headers), owner);",
};
