# Repository operations

This document records the public repository configuration that complements the
versioned source files. Keep it in sync when the project name or hosting
changes.

## GitHub About

Configure the repository's **About** panel with:

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| Description | Structured server applications for Angular and Analog, powered by H3.                      |
| Website     | `https://strata-www.pages.dev`                                                             |
| Topics      | `angular`, `analogjs`, `h3`, `nitro`, `typescript`, `server-framework`, `cloudflare-pages` |

Enable Issues and Discussions when the maintainers are ready to support them.
The README, licence, contribution guide, Code of Conduct, and security policy
should be displayed in the About panel.

## Branch and CI policy

Protect `main`: require pull requests, dismiss stale approvals after new
commits, and require the **Verify** status check. Do not require the
experimental consumer qualification check until its documented strict H3 type
blocker is resolved.

The `CI` workflow runs on every pull request and push to `main`. It deploys the
official website only after a successful push to `main`; never expose the
Cloudflare token to a pull-request workflow.

Configure these repository secrets before enabling production deployment:

- `CLOUDFLARE_API_TOKEN`: least-privilege token with Cloudflare Pages edit
  access for `strata-www`.
- `CLOUDFLARE_ACCOUNT_ID`: account that owns the Pages project.

The `website-production` GitHub Environment creates an auditable deployment
record. Add environment protection rules there if production deploys need an
approval.

## Releases

Use annotated, signed `vMAJOR.MINOR.PATCH` tags. The `Release` workflow
re-validates a tag and turns it into a GitHub Release using generated notes.
For the current pre-1.0 phase, use explicit prerelease tags, for example
`v0.1.0-alpha.1`. Do not create a release until the tag commit is on `main`
and the required checks are green.
