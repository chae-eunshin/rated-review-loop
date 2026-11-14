# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).
While the version is 0.x, the config, ledger and command output formats may still change.

## [0.1.0-rc.2] - 2026-11-15

### Fixed

- The session review request names the report file (`.rated-review-loop/local/work/<run-id>/report.json`). A report
  saved inside the review scope made `submit` reject the review as stale. ([#12])
- The bundled skill is shown as `node_modules/rated-review-loop/skills/...` instead of pnpm's store path. ([#12])

### Changed

- The package is a CLI only: no type declarations or source maps are published, and importing it fails explicitly.
  The tarball went from 51 to 23 files. ([#7])
- Each command's JSON output has a declared type (`PhaseResult`, `Packet`, `RunStatus`, `RateResult`). ([#9])
- The health workflow example runs the version pinned in `package.json` through `npx` instead of
  `npm install --no-save`, which failed in pnpm workspaces. It uses Node 24 actions. ([#6])

### Added

- Results from six weeks of real use in the README. ([#5])
- Design document (`docs/design.md`).

## [0.1.0-rc.1] - 2026-11-14

First pre-release, distributed as a GitHub release tarball.

### Added

- Review loop: `begin`, `ready`, Stop hook checks, `packet`, `submit` / `review`, `rate`, `status`, `cancel`, `stats`.
- Session, `claude-cli` and `codex-cli` reviewers; Claude Code and Codex hooks.
- Committed ledger and a pull request health check.
- `prune` for finished local runs. ([#2])

### Changed

- Snapshots store git blob ids instead of file contents. On a 866-file app, the stored baseline per run went from
  4.8 MB to 74 KB. ([#2])
- `ready` leaves binary and over-2 MB files out of the review and reports them as `notReviewable`. ([#2])
- Hook events, reports, runs and ledger entries are validated with zod; runs are typed per phase. ([#3])

### Fixed

- The review skill spells out the full `npx rated-review-loop rate ...` command. ([#4])

[0.1.0-rc.2]: https://github.com/chae-eunshin/rated-review-loop/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/chae-eunshin/rated-review-loop/releases/tag/v0.1.0-rc.1
[#2]: https://github.com/chae-eunshin/rated-review-loop/pull/2
[#3]: https://github.com/chae-eunshin/rated-review-loop/pull/3
[#4]: https://github.com/chae-eunshin/rated-review-loop/pull/4
[#5]: https://github.com/chae-eunshin/rated-review-loop/pull/5
[#6]: https://github.com/chae-eunshin/rated-review-loop/pull/6
[#7]: https://github.com/chae-eunshin/rated-review-loop/pull/7
[#9]: https://github.com/chae-eunshin/rated-review-loop/pull/9
[#12]: https://github.com/chae-eunshin/rated-review-loop/pull/12
