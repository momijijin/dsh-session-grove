# dsh-session-grove

[English](README.md) | [中文](README.zh.md)

A free-form grouping layer over the DSH Desktop workspace/session sidebar. Sessions from different workspaces can be assigned to the same group **without changing** their official workspace membership, logs or `workspace.json`; the plugin stores a separate group assignment.

- grouping changes only this plugin's record and where a session appears in the Free Groups view;
- official workspace membership, the workspace registry and session logs are never changed;
- session titles and archive state change only through explicit user actions or the opt-in `controlSessions` API;
- `workspace.json` is never written.

## Documentation

**Illustrated guides (Chinese): <https://momijijin.github.io/dsh-session-grove-docs-site/>**

The site covers installation and the 60-second start, groups, session assignment, profiles, search, header status, settings/AI control, data and backups, FAQ and per-version update notes. The same entry is linked from the first-run hint/card and from the plugin settings page.

- Current version: **0.4.0-beta.63** (latest published release, 2026-11-12)
- DSH range: `>=0.2.0-rc.2 <0.3.0`; verified on community DSH Desktop Stable 2.0.18 (DSH 0.2.1-rc.2) and official DeepSeek Harness desktop 0.2.2.0 (DSH 0.2.2-rc.1)
- Not supported: community DSH Desktop Beta and NEXT
- CI runs the Node-level gate on Ubuntu, Windows and macOS; the real DSH UI has been verified on Windows only
- 19 UI dictionaries, following the host language; there is no plugin-level language switch
- MIT

## Install

1. Install `dsh-session-grove` from **dshmarket** and restart DSH Desktop when the host asks.
2. Install and update through dshmarket / the plugin manager; the plugin does not self-update.
3. Upgrading from the old `dsh-session-groups` identity does not migrate data automatically — see [docs/MIGRATION-0.4.md](docs/MIGRATION-0.4.md).

Local tarball and CLI installs are maintainer/debug paths only; see [docs/RELEASE.md](docs/RELEASE.md).

## Quick start

1. Open **Free Groups** from the grid icon in the workspace header. The first launch shows a one-time hint that links this documentation.
2. Create a group.
3. Drag sessions from any workspace into it; drag group headers to reorder or nest them (up to 8 levels).
4. Drag a session out of a group to return it to Ungrouped.

## What you can do

- switch between the official workspace view and Free Groups; drag-resize the sidebar and restore the default width;
- groups: create, rename, icon, palette or custom color, reorder/reparent by drag, collapse, delete with a destination picker;
- sessions: assign across workspaces, create inside a group, open/rename/archive, fork and Copy Session ID;
- profiles: named group configurations, switch after a read-only difference preview, undo, archive;
- archive: independent session/group tri-states; an archived group's recursive subtree becomes structurally read-only while its sessions stay open;
- search across titles, workspaces and group paths; header running/waiting/unread counters;
- optional AI control through the host-native `session_grove_control` tool (all gates off by default).

## Configuration

The **Plugins → dsh-session-grove** page starts with a documentation entry and five opt-in switches: `diagnostics`, `debugProbe`, `controlApi`, `controlSessions`, `controlDestructive`. Every switch has an information tooltip covering behavior and security impact; destructive control requires an explicit confirmation. The security boundaries and AI-control usage are documented in [Settings & AI control](https://momijijin.github.io/dsh-session-grove-docs-site/2026/11/12/设置与%20AI%20控制/).

## Data

Group records live under `<dshHome>/storages/` (`dsh-session-grove.json`, the profile registry and one directory per named profile), with `.bak` backups and quarantine files. Official workspace/session data is never written. Uninstalling restores the shipped view and keeps the group data for a later reinstall. Full details: [Data, backup and recovery](https://momijijin.github.io/dsh-session-grove-docs-site/2026/11/12/数据、备份与恢复/) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limitations

- header counters include only explicitly grouped or explicitly ungrouped sessions;
- group, collapsed and dialog state are per window; cross-window conflicts return 409 and are not merged live;
- the active profile is global to the DSH instance;
- AI control can read and write a selected profile but cannot activate one;
- search returns at most 20 matches;
- collapsed subtrees are still built by `buildRenderTree`; large-list lazy rendering is deferred.

## Development

```powershell
npm run check:style
npm test
npm run build
npm run check:lib
npm run check:ui
npm run check:coverage
npm run check:release
```

Maintainer documentation: [docs/INDEX.md](docs/INDEX.md) — architecture, compatibility, i18n, test matrix, release process and ADRs. Release notes: [docs/release-notes/](docs/release-notes/) and [GitHub Releases](https://github.com/momijijin/dsh-session-grove/releases). Current test status: [docs/TEST-MATRIX.md](docs/TEST-MATRIX.md).

## License

MIT. See [LICENSE](LICENSE).
