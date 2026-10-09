# Dioptra 1.0.0: remaining gaps

Current as of 2026-10-09. Dioptra is a migration-testing browser, not a complete Chrome replacement. See the [README](../README.md) for supported features and [verification](verification.md) for tested platforms and limitations. The items below are remaining gaps, not promised release dates.

## Available in 1.0.0

Per-site storage reset, per-domain SSL exceptions, certificate inspection and public updates are implemented. Domain/IP and SSL changes apply immediately without restarting the app. Settings has six categories; Library supports search and download controls. Claude updates are checked and staged separately, then installed only on request with rollback on failure. Compare, Differences, DNS records, Site info, find, bookmarks and browsing history are available.

## Highest value for migration work

| Missing capability | Why it matters |
| --- | --- |
| Import/export domain rules | Move mappings between computers and keep backups. |
| Named migration projects | Switch between client configurations without rebuilding the rule list. |
| Per-project browsing isolation | Keep client cookies and website storage separate. The existing Live comparison session is separate, but is not a general project/profile manager. |

## Everyday browser features not implemented

- Dedicated crash-session recovery beyond restored tab URLs. Closed-tab reopening now works within the running session.
- Resuming interrupted downloads after restarting the app. In-session progress/pause/resume/cancel and persistent download records are implemented.
- Multiple named browser profiles, private windows and per-project cookie isolation.
- Saved site-permission management and password/autofill management.
- Browser-managed print/PDF controls and a broader accessibility/desktop acceptance pass.
- Full Chrome extension compatibility. Claude has an experimental installer and API bridge; other extensions, multiple browser windows and Claude Desktop/native-host pairing are unsupported. A complete signed-in Claude conversation remains outside automated verification.
- Chrome sync, DRM streaming and screen sharing are not promised or verified.

## Release/distribution work

- Apple Developer ID signing/notarization and Windows code signing. Mac releases use the existing SolutionMAX signing identity; Windows installers are unsigned.
- Broader native hardware/distribution coverage. Ubuntu 24.04 installation and ordinary-user tests pass, but FUSE mounting and physical GPU behavior were not tested. Intel Mac packages were exercised through Rosetta on Apple Silicon, not separate Intel hardware.
- Further performance profiling with real customer websites. Recent changes reduce app overhead; there is no claim of universally faster page loads.

Real 0.7.6 → 1.0.0 download, installation and relaunch tests passed for Linux AppImage, Mac arm64 and Windows x64 through isolated local feeds. Both Mac architectures, the Linux AppImage, Ubuntu/Debian amd64 package and Windows x64 installer have release verification coverage; see the detailed report for the exact tests.

Rule export/import, named projects and per-project browsing isolation are the main remaining migration-workflow gaps.
