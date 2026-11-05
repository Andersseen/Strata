# Mandatory CI acceleration

Date: 2026-11-05. Starting main: `94347ea3b6a991ab68d7e5d1a0c9b397b26b3da5`. Branch:
`stabilize/pre1-ci-edge-runtime-hardening`. Every number below is from GitHub-hosted `ubuntu-latest`
job and step timestamps (`GET /actions/runs/{id}/jobs`), never from local timings. "Wall" is run start
to the completion of the aggregate `Verify` job; "runner time" is the sum of the mandatory jobs'
durations (Verify and the website deploy excluded).

## Result

|                                      | Before (5 successful runs)           | After (successful runs)            |
| ------------------------------------ | ------------------------------------ | ---------------------------------- |
| Mandatory wall time                  | 22.9 / 23.2 / 30.5 / 31.4 / 32.3 min | 10.2 min (42055399997)\*           |
| Slowest job                          | consumers, 22.3–31.3 min             | 8.9 min                            |
| Runner time (mandatory jobs)         | 54.6 / 64.5 / 68.3 / 65.0 / 63.4 min | 68.2 min                           |
| Mandatory jobs                       | 5                                    | 11                                 |
| Required commands                    | 34                                   | 35 (34 + the F6 multi-isolate run) |
| Full workspace builds (`pnpm build`) | 5 (one per job, ~40 s)               | 2 (static, apps)                   |
| Package-only builds                  | 0                                    | 9 (~9 s each)                      |
| Chromium installs                    | 4, with apt `--with-deps`            | 9, browser only, apt on failure    |
| Setup step of a browser job          | 65–116 s, outliers 637–648 s         | 22–44 s                            |

\* 10.2 min includes a 76 s wait for a runner; the jobs themselves finished 8.9 min after the first
started. Hosted run 42050868101 (same pipeline, one shard failing on a step-order defect fixed
since) finished in 9.2 min; 42053069517 in 9.3 min. The median wall time therefore went from 30.5 to
about 9.5–10 minutes, inside the 10–12 minute target; the stretch target (≤ 10 min) is met when no
runner queueing occurs and missed by the queueing alone otherwise. Runner time rose from a median of
64.5 to 68–72 minutes (+5–12 %), within the +25 % budget, because six more jobs each pay ~30 s of setup.

## Baseline (before)

Runs: [42037152530](https://github.com/Andersseen/Strata/actions/runs/42037152530) (PR, `12ef086`),
42031033865 (main, `e655455`), 42015797764 (main, `54a0201`), 42011440742 (PR, `80e12bd`),
42043494173 (main, `94347ea`). Five jobs ran in parallel; each ran its commands sequentially.

| Job       | 42037152530 | 42031033865 | 42015797764 | 42011440742 | 42043494173 |
| --------- | ----------- | ----------- | ----------- | ----------- | ----------- |
| consumers | 1337 s      | 1386 s      | 1820 s      | 1829 s      | 1879 s      |
| runtime   | 888 s       | 1168 s      | 989 s       | 890 s       | 796 s       |
| graph     | 637 s       | 866 s       | 841 s       | 766 s       | 620 s       |
| apps      | 249 s       | 321 s       | 282 s       | 274 s       | 335 s       |
| static    | 168 s       | 132 s       | 165 s       | 141 s       | 174 s       |

Critical path: `consumers`, nine sequential commands (42037152530): packed Server Components
consumer 322 s, installed islands 288 s, deployment skew 155 s, full-stack consumer 138 s, Cloudflare
PoC 146 s, adversarial smoke 86 s, packed DI 65 s, full-stack Cloudflare rehearsal 52 s, TS 5.9
consumer 9 s. Two single commands (322 s and 288 s; 445 s and 382 s on slower runners) are the floor
that no regrouping can go below.

Setup breakdown (composite `.github/actions/setup`, consumers job of 42037152530): pnpm 5 s, Node and
pnpm-store cache restore 4.5 s, `pnpm install --frozen-lockfile` 2 s, `pnpm build` **40 s**,
`playwright install --with-deps chromium` **18 s**. The full build also built `apps/www`,
`apps/relay` and `apps/analog-fixture` (~75 % of it; 10 s of 67 s locally is packages), output that
every Server Component, Analog and consumer suite discards because each builds its own fixture or
external consumer from source.

Setup outliers: in 42043494173 the consumers setup took **637 s** and in the first post-split run
(42046849111) the `graph-ssr` setup took **648 s**. Both are `--with-deps` downloading font packages
from the Azure Ubuntu apt mirror at ~24 kB/s ("Fetched 13.5 MB in 9min 22s").

## What changed and why it is faster

1. **Split by measured time, not by theme alone.** The same commands run in eleven jobs, each with at
   most ~6 minutes of test time on the slowest observed runner. Grouping keeps related suites together
   and isolates the two irreducible long commands in their own jobs:

   | Job                    | Commands                                                              |
   | ---------------------- | --------------------------------------------------------------------- |
   | `static`               | actionlint, format, lint, typecheck, `pnpm test` (incl. `test:ci`)    |
   | `graph-ssr`            | graph PoC, navigation, `@defer`, server-only firewall                 |
   | `graph-dev`            | optimizer firewall, dev server                                        |
   | `runtime-failures`     | failure/recovery, request context                                     |
   | `runtime-security`     | confidentiality, SSR response, authorization                          |
   | `runtime-analog`       | Analog fixture, streaming, observability, correlation, headers, forms |
   | `consumers-package`    | packed Server Components consumer, TS 5.9 consumer                    |
   | `consumers-islands`    | installed islands, packed Angular DI                                  |
   | `consumers-full-stack` | full-stack consumer, multi-isolate harness (new), adversarial smoke   |
   | `consumers-edge`       | deployment skew, full-stack Cloudflare rehearsal, Cloudflare PoC      |
   | `apps`                 | website e2e, website dogfood, Relay dogfood                           |

2. **Build what is read.** Nine jobs build only `packages/*` (`build: packages`, 9 s instead of 40 s);
   `static` and `apps` keep the full workspace build they read.
3. **No apt on the critical path.** Chromium is installed without `--with-deps`, then launched; only a
   failed launch installs system packages. Across hosted runs 42050868101, 42053069517 and
   42055399997 the fallback never fired (no `##[warning]` annotation, no apt activity): the image
   already carries Chromium's shared libraries. The 9–10 minute mirror stalls are gone with it.
4. **Chromium only where a browser runs.** `runtime-analog` (HTTP-only `tools/analog/*`) skips it.

After setup, the per-step timings in 42050868101 match the baseline commands (for example packed
consumer 468 s, installed islands 324 s, failure/recovery 260 s): the gain is parallelism and setup,
not faster tests.

## Coverage is preserved, and checked

`tools/ci/required-commands.json` lists every command of the baseline workflow with the job it ran in,
plus commands added since (with a reason). `pnpm test:ci` (part of `pnpm test`, so of the `static`
job) parses `.github/workflows/ci.yml` and fails when a listed command is missing, runs twice, carries
an `if:` or `continue-on-error`, sits in a job `Verify` does not need, or when an unlisted `pnpm`
command appears in a mandatory job. It also rejects an aggregate gate without `if: always()`, without
`join(needs.*.result)`, with an `EXPECTED_JOBS` count that differs from its needs, or that can pass
on a non-`success` result, and a concurrency policy that can cancel main runs. Eleven unit tests mutate
the real workflow to prove each rule. Applied to the baseline workflow, the check places all 34
commands (proving the inventory equals the old pipeline) and fails only on the new rules
(main cancellation, per-SHA grouping, missing `EXPECTED_JOBS`).

No suite moved to Extended, none became conditional, none was mocked.

## Verify and Release

`Verify` keeps its name and job id, needs all eleven jobs, runs with `if: always()`, fails on any
result other than `success` (`failure`, `cancelled`, `skipped`) and on a result count other than 11.
The Release authorizer still requires exactly one successful `Verify` in the exact source run of a
main push whose SHA is still main.

## Cancellation

Before: `group: CI-<ref>` with `cancel-in-progress: true` for every event. A later merge cancelled main
run 42041343959, leaving `01f7e8e` without a Verify (its Release run 42043634935 correctly refused the
cancelled source), and could cancel `deploy-www` mid-upload.

After: pull requests share one group per PR and cancel superseded runs (observed: 42053069517's
re-run and 42055144822 were cancelled by newer pushes to this PR). Main pushes get one group per SHA
and are never cancelled. `deploy-www` is serialized in its own group and never cancelled. The deployed
qualification and rollback workflow (`full-stack-deployed-cloudflare.yml`), Release and Extended were
already `cancel-in-progress: false` and are unchanged.

## Hosted runs of the new pipeline

| Run                                                                          | Head      | Result                                                                                     | Wall     | Runner   |
| ---------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------ | -------- | -------- |
| [42046849111](https://github.com/Andersseen/Strata/actions/runs/42046849111) | `aec2d64` | success                                                                                    | 18.7 min | 79.0 min |
| [42050868101](https://github.com/Andersseen/Strata/actions/runs/42050868101) | `e5590fc` | failure: multi-isolate step ran after the adversarial smoke removed its reuse root (fixed) | 9.2 min  | 72.5 min |
| [42053069517](https://github.com/Andersseen/Strata/actions/runs/42053069517) | `e73fc39` | failure: installed-island check L (intermittent, below)                                    | 9.3 min  | 70.9 min |
| [42055399997](https://github.com/Andersseen/Strata/actions/runs/42055399997) | `0e0323e` | **success**, 11/11 jobs                                                                    | 10.2 min | 68.2 min |
| [42060660230](https://github.com/Andersseen/Strata/actions/runs/42060660230) | `962b7b5` | **success**, 11/11 jobs                                                                    | 10.2 min | 69.8 min |

42046849111 is the split before the Chromium change; its 18.7 minutes are the 648 s apt stall plus
the tests.

## Reliability notes

- Installed-island check L ("a package version that lacks the used input or export fails the
  production build closed") failed once (42053069517) and passed in every other hosted and local run.
  The build did fail closed; the check requires the diagnostic to name the missing input or export,
  and that time Rolldown surfaced Strata's AOT-integrity refusal for the same uncompilable Server
  Component first. The suite was not changed here; the assertion's diagnostic expectation is
  ordering-dependent and is recorded as an open item, not retried away.
- The per-job runner queue is now visible (76 s once): eleven jobs request eleven runners at once.

## Remaining opportunities

- The floor is now `installed-island` + packed DI and the packed Server Components consumer
  (~8–9 min each including setup). Splitting the installed-island suite internally (its Node and
  workerd matrices are independent) would lower it further.
- `static` and `apps` still pay the full workspace build (~40 s); a typecheck that resolves packages
  from source would remove it.
- The website and Relay e2e still install Chromium inside a job that also builds both apps;
  caching the Playwright browser directory keyed by its version would save ~10 s per job.
