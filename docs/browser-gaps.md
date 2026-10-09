# Dioptra: what is still missing?

Historical assessment of version 0.5.0. For current functionality and downloads, see the [README](../README.md). Several gaps below, including per-site reset, per-domain SSL and public updates, were subsequently implemented.

Scope: a migration-testing browser, not a complete Chrome replacement. Reviewed against the current 0.5.0 source on 2026-09-29. These are recommendations, not features silently added to the release.

## Highest value for migration work

| Missing capability | Why it matters |
| --- | --- |
| Import/export domain rules and named projects | Move mappings between computers, back them up and switch client projects quickly. |
| Per-site storage reset | Current Clear cache preserves cookies, local storage and service workers; these can obscure migration tests. |
| Per-domain certificate exceptions | 0.5.0 provides a global strict/bypass setting with restart. Individual-domain policies and detailed certificate inspection remain future work. |

## Everyday browser features not implemented

- Dedicated crash-session recovery beyond restored tab URLs. Closed-tab reopening now works within the running session.
- Resuming interrupted downloads after restarting the app. In-session progress/pause/resume/cancel and persistent download records are implemented.
- Multiple named browser profiles, private windows and per-project cookie isolation.
- Saved site-permission management and password/autofill management.
- Browser-managed print/PDF controls and a broader accessibility/desktop acceptance pass.
- Full Chrome extension compatibility. Since 0.4.0, Claude has an experimental installer and API bridge; the Claude interface is confirmed working since 0.4.5; complete Chrome-extension parity remains unverified. Other extensions are unsupported.
- Chrome sync, DRM streaming and screen sharing are not promised or verified.

## Release/distribution work

- A default live update feed and real old-version → new-version installation tests.
- Apple Developer ID signing/notarization and verified Mac OTA installation. Current Mac builds use ad-hoc signatures.
- Real Linux desktop acceptance tests across target distributions; the development root harness is not a substitute.
- Further performance profiling with real customer websites. Recent changes reduce app overhead; there is no claim of universally faster page loads.

Recommended next three: rule import/export + project sets, per-site storage reset, and detailed certificate inspection. These directly improve migration testing without turning Dioptra into a general-purpose browser project.

Implemented in 0.5.0: side-by-side Hostfile/Live with separate storage, observed IP banners, switchable SSL policy after restart, find, bookmarks, history, closed-tab reopening and downloads. Live uses normal OS DNS, not Dioptra overrides; its temporary session is not restored after app restart.
