# Spec-Driven Development workflow

Astra owns vision, architecture, compatibility, risks, roadmap, specs and architectural review.
Implementation agents own production code, fixtures, tests, refactors and implementation PRs.
Astra's authoring/review runs do not modify production code in `packages/`, `apps/` or `src/`.

## One slice at a time

1. **Inspect.** Astra reads the current branch, diff, recent commits, packages, tests and relevant
   upstream documentation. Compare the current implementation with STATE; do not treat an earlier
   prompt or roadmap as proof that code is absent.
2. **Reconcile.** Update state, architecture, roadmap and risk dispositions only where new evidence
   changes them. Accepted decisions remain traceable through ADRs.
3. **Specify.** Write one bounded spec with exact scope, constraints, public API effects, observable
   acceptance criteria and required tests. Future milestones remain at capability level.
4. **Implement.** The assigned implementation agent confirms the baseline, implements only that
   spec, runs its checks and submits code/tests plus a PR evidence table keyed to acceptance IDs.
   It records blockers and proposes options when a design decision exceeds the spec.
5. **Review.** Astra compares behavior, public API, package imports, runtime assumptions and evidence
   with the spec and global architecture. Examine the diff and tests, not only the agent summary.
6. **Record.** Astra marks the spec accepted only after required evidence passes, updates STATE and
   roadmap gates, and writes/supersedes an ADR if an important decision was established. The
   implementation agent addresses code changes from review.
7. **Continue.** Draft the next spec from the resulting repository. Do not prepare detailed later
   specs while their architectural prerequisites are unknown.

## Spec state and handoff

Use `Draft → Ready → In progress → In review → Accepted`, with `Blocked` and `Superseded` as explicit
alternatives. Keep at most one **Ready or In progress** implementation spec. Each records baseline
commit, milestone, dependencies, relevant ADR/risk IDs and owner role. The specs index owns status.

“Ready” means the implementation agent can make routine local implementation choices without
choosing the framework's architecture. A spike spec fixes the experiment, inputs and deliverables;
its report may legitimately say no-go. Successful completion of a spike is not successful validation
of its hypothesis.

When a prerequisite changes, the agent reports the exact conflict and stops dependent work. It can
complete independent checks already in scope. Astra revises or supersedes the spec before broader
code changes. No agent may silently invent a new compiler protocol, DI container, package, H3 target
or definition of Server Components to make an acceptance test pass.

## Implementation PR evidence

The PR identifies the spec, baseline and final commit; lists changes in public behavior and package
dependencies; maps acceptance IDs to test names/results; provides exact versions, commands and
artifact links; records limitations and unrun checks; and includes a Changeset/migration note when
package behavior warrants it. A tooling-only slice explains why no package release is needed.

Astra checks:

- Intended behavior is covered, including relevant failure and concurrency paths.
- No unauthorized architecture, dependencies or packages appeared in the implementation.
- Core stays independent; native H3 and Analog primitives still have their proper role.
- Compiler, request scope, browser boundaries and compatibility claims match executed evidence.
- Source, declarations and installed-package behavior agree; a happy-path demo is insufficient.
- The next slice is still the highest-value bounded step after this evidence.

## ADR discipline

Use numbered Markdown files with date, status, context/evidence, decision, consequences,
alternatives and reopening triggers. `Accepted` records a justified decision; `Proposed` is not
authorization to rely on an untested mechanism. Supersede a record with a link instead of rewriting
history to hide a reversal.

Record standard decorators, H3 target, DI ownership, compiler strategy and component/navigation
protocol when justified. Do not create ADRs for filenames, ordinary refactoring or every test case.
At this baseline only ADR-001 through ADR-003 are accepted. Later mechanisms remain open.

## Maintaining documentation

[docs/README](README.md) maps authority. Update that document when ownership changes; link rather
than repeat complete checklists or upstream research. STATE is a dated audit, not an eternal support
claim. Keep risk rows open where evidence is incomplete. Use the spec template in
[specs/README](specs/README.md), including for focused experimental work.
