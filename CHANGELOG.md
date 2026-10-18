# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A plugin runs inside a host it does not own, so each release states the DeepSeek Harness range it
supports. The same requirement is enforced at load time through `engines.dsh`: a harness outside the
range refuses the bundle instead of running it against an API it no longer matches.

## [Unreleased]

## [0.2.0] - 2026-10-19

Requires DeepSeek Harness **0.2.1-rc.2 or newer, within 0.2.x**.

### Added

- `engines.dsh` declares the supported harness range, so the host decides compatibility from one
  range and reports the skipped bundle by name at startup. On 0.2.1-rc.2 the previous release was
  dropped silently: the 0.1.x peer ranges no longer matched, so the plugin never loaded and all ten
  tools disappeared without an error the user would see.

### Changed

- **Breaking:** the 0.1.x line of this plugin supported harness 0.1.x only. The two are not
  interchangeable, and a release now says which it targets.
- A settled background job reports its value as `result` rather than `output`, following the 0.2.x
  job API.
- A background job's owner is the owning session id rather than the agent object.
- Peer dependencies move to `^0.2.1-rc.2`.

## [0.1.1] - 2026-09-20

Requires DeepSeek Harness **0.1.x**, from 0.1.5-rc.2 onward.

### Added

- README install instructions for npm, leading the section, with the checkout and GitHub paths
  below it.
- Update and removal commands, and a note that a running harness picks up a bundle change only at
  the next start.

### Changed

- The model-guidance section now empties itself when the `jules_*` tools are out of scope, matching
  `tool:read` and `tool:subagent`. An agent whose preset excluded the family was previously told
  about tools it could not call.
- The waiting half of that guidance names `jules_watch` only when the tool is registered, so
  `enableWatch: false` no longer advertises a tool the composition does not provide.
- The guidance opens with an instruction and states policy, rather than describing Jules and
  restating what each tool already documents.

## [0.1.0] - 2026-09-20

Requires DeepSeek Harness **0.1.x**, from 0.1.5-rc.2 onward.

### Added

- Ten `jules_*` tools: `jules_sources`, `jules_create`, `jules_list`, `jules_status`,
  `jules_activities`, `jules_approve_plan`, `jules_send_message`, `jules_watch`, `jules_wait`,
  and `jules_patch`.
- A `fetch` client for the documented v1alpha REST API, with bounded retries on 429 and 5xx, typed
  errors, and typed partial signals.
- Background watches through the job registry, plus a foreground wait that shares the same settling
  rules.
- A durable watch journal, so a restart reports which watches were still armed even though the jobs
  themselves cannot be restored.
- Plan approval confirmed by its event rather than by the phase the service returns with.
- A model-guidance section that leads with create, watch, end your turn.

[Unreleased]: https://github.com/rbviz/dsh-plugin-jules/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rbviz/dsh-plugin-jules/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rbviz/dsh-plugin-jules/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rbviz/dsh-plugin-jules/releases/tag/v0.1.0
