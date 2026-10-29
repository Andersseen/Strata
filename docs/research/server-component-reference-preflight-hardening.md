# Server Component client reference preflight hardening (candidate)

## Scope and starting point

Starting synchronized `origin/main` SHA: `08ad41305890eaa4d081f3fd031751cba2635904` (PR #148,
Server Components 0.11.0). Feature branch: `feat/server-components-reference-preflight-hardening`.
PR #150 (the 0.12.0 versioning PR) was open and untouched; its Changeset is preserved and this work
adds one focused minor Changeset, so Changesets calculates the release sequence. Tuple: the
repository-locked one; local evidence only, not a support declaration.

## Existing behavior (PR #149), not reimplemented

Generated surrogates carry `{ type, expectedSelector }` descriptors; the runtime reflects each
component once with `reflectComponentType`, and a mismatch, a duplicate actual selector or a
non-component fails the whole host as a `reference` preflight refusal before any island exists.

## Baseline reproduced

Real Angular metadata (`@angular/compiler`, JIT) plus minimal synthetic descriptors, against the
unmodified `buildClientReferenceRegistry`:

| Case                                          | Baseline                         |
| --------------------------------------------- | -------------------------------- |
| A. throwing `type` getter                     | **threw** out of the constructor |
| B. throwing `expectedSelector` getter         | **threw**                        |
| C. `expectedSelector` a number                | **bypassed** (check skipped)     |
| D. `expectedSelector` null                    | **bypassed**                     |
| missing `expectedSelector` key / object value | **bypassed**                     |
| E. empty string                               | refused (as a mismatch)          |
| F. malformed selector                         | refused (as a mismatch)          |
| G. Angular reflection that throws (Proxy)     | **threw**                        |
| H. valid reference after an invalid one       | invalid one bypassed, no problem |
| I. valid component, different actual selector | refused                          |
| J. two components, one selector               | refused                          |
| inherited accessors on a descriptor           | **read** (consumer getters ran)  |

The constructor calls the builder outside the `afterNextRender` preflight, so the thrown cases
escaped the established `reference` contract (and ran during construction). Case G was reproduced
with a throwing Proxy standing in for corrupt metadata, not with a corrupt compiled component.

## Hardened contract

- A plain component type is accepted as before; its checks that need no descriptor still run.
- A descriptor must carry `type` and `expectedSelector` as **own data properties**. Accessors,
  inherited properties, missing keys and non-objects are refused without invoking consumer code.
- `expectedSelector` must be a string matching the build's custom-element contract
  (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$`, the same expression as `analyze.ts`).
- Reflection is the only operation wrapped to catch: a throw becomes "component metadata could not
  be read". Property inspection is wrapped per reference, so one hostile reference is reported by
  position and never hides a bug elsewhere.
- A registry that is not an array, or whose element access throws, is refused.
- The first problem wins; later references are not inspected.

Diagnostics contain only the reference position, the public selectors and fixed text. No consumer
`toString`/`valueOf`/getter runs, no descriptor is stringified, and thrown messages are discarded.
Unit canaries assert this for the getter, Proxy and array-access cases.

## Ordering and failure handling

Unchanged: `planClientBoundaries` still checks the registry problem first for a host with
boundaries, so a reference problem is a `reference` category `StrataBoundaryError` and is never a
`StrataBuildMismatchError`; only the latter reaches skew recovery. Budget, metadata, build-identity
and protocol checks keep their order. No runtime change was needed in `islands.ts`: the builder no
longer throws, so the existing preflight path (one ErrorHandler delivery, one observer event with
`failureCategory: "reference"`) carries the failure.

## Evidence level

- **Unit tested:** the cases above (`client-references.test.ts`, 393 package tests pass).
- **Locally integrated:** see the local matrix results in the pull request description.
- **Not done in this candidate** (stated, not claimed): a dedicated real-browser negative
  scenario in the Analog fixture; installed-tarball negative cases (mismatched selector, duplicate
  selector, aliased inputs, reinstall); a clean-versus-stale Vite prebundle characterization;
  registry-build timing and bundle-size measurements; an island-level ErrorHandler/observer
  assertion for these failures. Compilation may reject a deliberately mismatched package before
  any browser test can render it; that distinction has not yet been measured.

## Remaining limitations

Local evidence only. Nothing here is hosted-CI, deployed or production qualification, and M4 and
Strata 1.0 are not marked complete.
