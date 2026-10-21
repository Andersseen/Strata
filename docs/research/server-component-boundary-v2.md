# Server Component structured boundary props and protocol v2

Status: implementation evidence for the experimental 0.3.0 candidate. This is not a protocol
stability decision or a 1.0 qualification.

## Starting point

- Synchronized main SHA: `d4b791e505446fa91a02610e84a36036499227ad`.
- Package manifest at start: `@strata-sc/server-components@0.2.1`.
- Branch: `feat/server-components-structured-props-v03`.
- The existing serializer and browser preflight accepted flat primitives only. Both checks were
  retained because server objects are untrusted inputs and browser markup may be stale or modified.

## Public API and values

The package exposes recursive readonly-compatible `ClientBoundaryPrimitive`,
`ClientBoundaryObject`, `ClientBoundaryValue` and `ClientBoundaryProps` types. Application
interfaces such as `ProductView` remain assignable; runtime checks, rather than a cast or type
annotation, enforce the complete shape.

Accepted values are strings, finite numbers, booleans, null, dense arrays and plain objects whose
prototype is `Object.prototype` or null. Objects and arrays may combine recursively within the
limits below. Every accepted value is copied into a fresh snapshot. Repeated non-cyclic references
are copied independently.

Rejected values include undefined, functions and closures, signals, symbols, BigInt, non-finite
numbers, class instances, services and repositories, Date, Map, Set, RegExp, Promise, unsupported
prototypes, cycles, sparse arrays, accessors, non-enumerable data, symbol properties, custom array
properties, custom toJSON functions and reserved keys. The reserved keys `__proto__`,
`constructor` and `prototype` fail at every depth. Reflective failures fail closed with a
sanitized error. Rejected values and user conversion methods are not printed or invoked.

| Limit         | Value                           |
| ------------- | ------------------------------- |
| Root props    | 64                              |
| Nested depth  | 8 containers                    |
| Values/nodes  | 512                             |
| Array items   | 128 per array                   |
| Object keys   | 64 per object                   |
| Encoded props | 65 536 UTF-8 bytes per boundary |

Limits are deterministic and checked by both server serialization and browser preflight. The UTF-8
limit measures serialized JSON bytes, including escaped strings.

## Encoding and compatibility

Flat primitive props use the existing v1 attributes and encoding. Any nested object or array selects
protocol v2 on that same SSR host. Props remain in the host-local `data-strata-props` attribute;
there is no global registry or selector-based matching.

| Server                  | Browser   | Behavior                                                      |
| ----------------------- | --------- | ------------------------------------------------------------- |
| Old v1                  | New v1/v2 | V1 is accepted.                                               |
| New v1                  | Old v1    | Existing flat payloads remain compatible.                     |
| New v2                  | New v1/v2 | Recursive validation and hydration.                           |
| New v2                  | Old v1    | Old browser rejects unknown version 2; SSR DOM remains inert. |
| Missing/unknown version | Either    | Fail closed, no fallback.                                     |

The v1/v2 shape is checked: v1 cannot carry nested values, and v2 must contain a nested object or
array. A malformed boundary fails the all-or-nothing preflight for its Server Component host.
Older browser assets do not hydrate v2 during a mixed deployment; seamless rolling skew is not
claimed.

## Examples

The package README shows the public view-model contract. The installed packed consumer now reduces
a server-only ProductRepository result to this model:

```ts
interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly variants: readonly {
    readonly id: string;
    readonly label: string;
    readonly stock: number;
  }[];
}
```

The server passes `{ product: publicProduct }` to an Angular island. The island receives a typed
readonly ProductView input, keeps a selected variant, and updates its stock output from a keyboard
action. Repository provenance remains server-only.

Relay's incident triage island also uses a nested view model containing incident details, a service
object and an actions array. It updates status through Relay's existing controller.

## Hydration and failure handling

The browser parser accepts valid v1 and v2 attributes and repeats the structural validation after
JSON parsing. Existing public Angular input-name and alias checks remain in force. Each validated
value is passed with Angular's public `ComponentRef.setInput`; no Ivy internals, global component
registry or duplicate Angular root was added.

All boundaries under a Server Component host preflight before creation. Invalid input creates no
island and leaves the server-rendered subtree inert. A commit error still destroys created roots and
restores their SSR hosts. Relay's v2 downgrade test mutates v2 markup to v1 in Chromium and checks
that the owning host remains unhydrated and its SSR controls remain attached.

## Verification evidence

Completed locally:

- Protocol unit and hydration-plan tests pass, including exact and immediately-over limits,
  nested getters and serializers, accessors, symbol keys, reserved keys, cycles, sparse/custom
  arrays, repeated references, throwing proxies, UTF-8 payload size and v1/v2 mismatches.
- Local CI commands pass: frozen pnpm install, root build, lint, typecheck, unit/release/performance
  tests, formatting, release tests and performance-tools tests. The Server Components graph,
  navigation, defer, server-only, security, request-context, authorization, failure-recovery,
  SSR-response and dev runners pass. The Cloudflare Pages/workerd rehearsal passes without
  deployment. Analog, generic package, packed Angular DI, full-stack packed consumer and www
  Server Components runners pass.
- Relay Node production build and Chromium suite pass. The v2 incident model hydrates with SSR DOM
  identity, keyboard interaction updates status through the existing controller, and server-only
  repository/source markers remain absent from browser artifacts. The v2-to-v1 tamper test passes:
  no boundary in the owning host hydrates and its SSR DOM remains attached.
- The external packed consumer builds and installs the actual 81,593-byte tarball outside the
  workspace. Strict TypeScript 6.0.3 (464 files) and 5.9.2 (425 files) checks report zero
  diagnostics, including the consumer-authored readonly ProductView interface. Node production
  SSR/hydration exercises one v1 and one v2 boundary; keyboard selection changes stock while
  preserving the SSR button. Vite development, native document navigation and Back/re-entry pass.
- The same packed consumer builds for Cloudflare Pages and passes the local Wrangler/workerd SSR,
  v1/v2 markup, hydration, DOM identity and keyboard interaction checks. No deployment occurred.
- The package tarball has no source imports, workspace aliases, symlink dependencies or duplicate
  framework copies. Its server-only repository, server helpers and implementation marker remain
  absent from browser JS and maps.
- Security scanning passes in both Nitro Node and workerd. It checks server and browser graphs,
  source maps, SSR and hydrated HTML, browser network responses, headers, error paths, unsupported
  nested repository values, and overlapping request isolation. Negative controls prove the scanners
  find the canary when the firewall is disabled. Operator logs are characterized separately and
  may contain the test canary from deliberate server-side errors; public surfaces do not.
- The www E2E suite passes (2 tests) against a fresh Node server on port 3001 because port 3000 was
  occupied. The www local Cloudflare build passes. Relay dogfood qualifies Node production; Relay
  itself is not run on workerd.
- Entwine 0.5.1 `check` validates 58 documents, 260 internal links and 44 repository references;
  `build` completes. Generated `dist/` output is ignored and is not part of the change.
- The package release dry-run packs and inspects all eligible tarballs. npm authentication is
  unavailable (E401); current manifest versions already exist on npm, so the script skips the
  `npm publish --dry-run` phase for them. No package was published or tagged. Changesets report
  independent minor bumps for Analog and Server Components.

Hosted GitHub Actions remain pending until the PR is pushed. No deployment, publication, or
release-version change was made. This evidence qualifies the local candidate, not production
adoption or protocol stability.

## Performance characterization

The same public product information encoded as flat v1 props is 67 UTF-8 bytes; the structured v2
`product { id, name, variants[] }` view is 137 bytes (+70 bytes, 104.5%). This measures payloads,
not transfer compression or hydration latency. The packed v2 candidate is 81,593 bytes (79.7 kB),
including declarations and maps.

A same-lockfile, same-toolchain Relay build compares the starting commit's v1 fixture with the
candidate's structured dogfood fixture. The diff includes the new Relay model and interaction as
well as the protocol implementation:

| Artifact                           |    Starting v1 |       Candidate |               Change |
| ---------------------------------- | -------------: | --------------: | -------------------: |
| Client JS, 7 chunks                |      483,950 B |       485,725 B |             +1,775 B |
| Island loader chunk (raw / gzip)   | 4.72 / 2.11 kB | 6.535 / 2.62 kB | +1.815 kB / +0.51 kB |
| Node SSR output directory          |    1,492,861 B |     1,496,949 B |             +4,088 B |
| Node `main.server.js`              |    1,353,243 B |     1,353,243 B |                  0 B |
| Cloudflare Worker output directory |    2,331,416 B |     2,337,052 B |             +5,636 B |

The production output reported no new hydration roots or measurable additional work; the packed
consumer confirms the existing DOM nodes are reused. This is a functional check rather than a
latency benchmark. The sizes are fixture-level differences, not universal package overhead or a
performance budget. No zero-overhead claim is made.

## Limitations

- Protocols remain experimental and may change before 1.0.
- Server Component Router subtree navigation remains unsupported.
- Streaming SSR remains unsupported.
- Angular JIT DI on workerd remains NO-GO; this runtime path does not add it.
- The full production compatibility matrix and deployment qualification remain open.
- Strata 1.0 is not yet qualified.
