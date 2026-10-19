# Server Component dev recovery CI regression

Date: 2026-10-19. Starting `main`: `ab96d1721ce8ff99c1312cbc09d7a635b3b5a551` (PR #90).
Branch: `fix/server-component-dev-recovery-ci`. This is development-server test evidence; it is not
production Server Component certification.

## Historical failure

- Actions run: [39065231918](https://github.com/Andersseen/Strata/actions/runs/39065231918)
- Failed graph job: `117491864126`, “Server Component graph (build, SSR, hydration, firewall)”.
- Failed step: `pnpm test:server-component-dev`.
- Actions checked out PR #90's merge commit `b32111d9cb2b91edbabcf360b3654fbbd8dbaae1`
  (release commit `821d9b0` into base `7ca8eb8`); this predates the synchronized local main SHA above.
- Exact failed assertion: `no failure line after the fix` in scenario K (invalid `(click)` binding
  in `DevChildComponent`, then restore).
- Other scenario verdicts, server liveness and byte-for-byte fixture restoration passed. The job
  showed the failure as a single failed assertion; aggregate `Verify` failed because the graph job
  failed. The other CI groups and separate Entwine validation passed.

The actual job log was retrieved from GitHub Actions. In scenario K its timestamps show this order:

1. At 8:14:03 PM, Vite reported the invalid event-binding diagnostic for `dev-child.component.ts`.
2. At 8:14:04 PM, the restored root and child sources refreshed successfully. Vite logged that the
   graph was valid again and dispatched the recovery document reload; additional restored fixture
   files also refreshed.
3. The browser reloaded, hydrated, and successfully fetched the island module. The server stayed up.
4. At the assertion, the captured byte-offset window included the 8:14:03 PM diagnostic, even though
   its event timestamp preceded the successful recovery event. K2 then passed its equivalent
   recovery assertion. J and all other scenarios passed.

This confirms a harness log-window race, rather than a plugin re-entry into failed graph state: the
assertion took its output mark before `ctx.edits.restore()`, while asynchronous child-process output
could arrive after that mark. The captured string was ordered by delivery to the parent process, not
by when the Vite event occurred. No evidence in the historical log indicates a fresh failed graph
refresh after recovery.

## Change

`checkInvalidEdit()` now defines recovery through observable behavior: document reload, route return,
hydration and a successful browser module request. It then waits for a bounded quiet period before
marking the post-recovery log window, waits for another bounded quiet period, and still fails on any
failure diagnostic in that window. A quiet-period timeout is a test failure. This avoids attributing
already-emitted output delivered late to a state after the fix; it does not clear or suppress logs.

Scenario K adds a strict second negative control: after a successful recovery, it applies the invalid
event binding again. The test requires a new diagnostic and HTTP refusal while invalid, then restores
the source and requires another document reload, hydration and HTTP 200. Existing J/K/K2 controls
continue to require failure diagnostics, the Vite overlay, refusal of an unrelated app module, and a
live server while the graph is invalid. Firewall/plugin implementation and public APIs are unchanged.

## Reproduction and qualification

Starting tuple on this machine: Node 22.23.1, Angular core/common/compiler 22.1.7, platform-browser
22.2.1, platform-server/router 22.2.2, Analog platform and Angular Vite plugin 2.7.2, Vite 8.3.0,
TypeScript 6.0.3, Playwright 1.62.1. GitHub's failed runner used Node 22.23.3 and Ubuntu 24.04.

- Before changes: the current-main focused gate passed once on macOS with the browser-capable host
  permission. Its first sandboxed attempt could not launch Chromium because of the host Mach-port
  permission restriction; that attempt did not reach any scenario.
- After changes: one complete real Analog/Vite/Chromium run passed all A–M and G2 scenarios, including
  the new K negative control. The run observed 152 graph refreshes (5–32 ms, median 8 ms); all 10
  touched fixture paths were byte-for-byte restored.
- Five further sequential runs passed (five successes, zero failures); each was a fresh Node process
  on the same macOS host. The five run logs are under `/tmp/strata-dev-gate-{1..5}.log` (the first
  post-change full run is in `strata-dev-gate-1.log`). No Linux local environment was available.
- `CI=true pnpm install --frozen-lockfile`, build, lint, typecheck, aggregate tests, formatting,
  release tests and performance-tool tests passed. The first sandboxed aggregate/performance attempts
  failed before test execution because their local HTTP fixture could not bind `127.0.0.1` (`EPERM`);
  the escalated reruns passed (aggregate unit tests, release tests and all 163 performance-tool tests).
- Sequential local integration checks passed: Server Component graph, navigation, `@defer`, server-only
  firewall, confidentiality, request context, failure/recovery, SSR response, authorization, Analog,
  core package consumer, Server Component packed consumer, full-stack packed consumer, full-stack local
  Cloudflare/workerd rehearsal, Server Component Cloudflare/workerd, website dogfood, Relay dogfood,
  website Playwright (2 tests) and website Cloudflare build. The Cloudflare full-stack runner printed
  `REAL DEPLOYMENT: NOT RUN`.
- The first attempt to run the website Playwright command on its default port reused an already-listening
  port 3000 and failed its `data-app-ready` assertion against that server. The port owner was left
  untouched. Rebuilding and running the suite against a fresh local Nitro server on port 3010 through
  `STRATA_WWW_BASE_URL` passed both tests.
- An initial attempt to launch several fixture builds without waiting between them caused shared
  `apps/analog-fixture/dist` outputs to overlap; those results are invalid and excluded. Every affected
  gate was rerun individually/sequentially and passed. The original workflow was preserved.
- Entwine CLI 0.5.1 `check` and `build` passed (51 documents); generated site output is ignored.
- Historical Actions result remains preserved and unchanged. No hosted run of this correction exists
  yet; PR CI is pending.

## Verdict and limits

Root cause is confirmed as harness-side asynchronous log delivery crossing a mark taken before
restoration. The production graph transaction and fail-closed firewall did not change. The new
negative control demonstrates fail-closed behavior after recovery as well as before it. This evidence
qualifies only this pinned Analog/Vite development fixture and host environment; hosted PR CI is still
required before calling the gate reproducibly green.
