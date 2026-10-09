# Verification — 2026-10-09

## 1.0.0 — Desktop release

The approved layout is implemented in the existing browser shell: larger text, a six-section Settings sidebar, searchable Library and explicit Claude extension updates. Domain/IP changes reload affected pages while keeping the application process, window and unrelated tabs alive. The final real-form test verifies this on Apple Silicon, Intel via Rosetta, installed Ubuntu and installed Windows, including the new IP’s actual page content and persisted rules.

- **Source:** 94 unit tests and 16 browser integration groups pass. Coverage includes Settings/Library, inspector resizing, domain saving, routing changes and history/TLS, direct Compare URLs, Site info, workspaces, servers, onboarding, the start-page scene and Claude session storage. Runtime dependency audit reports zero known vulnerabilities. Independent implementation and public-content reviews have no remaining blocking findings.
- **Ubuntu:** the actual amd64 `.deb` was installed with apt on Ubuntu 24.04. Eleven integration groups pass against the installed executable as an ordinary user. A separate packaged routing/TLS smoke test and the final real-form domain-save test explicitly enable the Chromium sandbox and assert that `--no-sandbox` is absent. The domain-save test awaits each state transition and verifies the second server’s actual page content after editing the IP, while asserting the same process/window, zero quit events and retained unrelated-page state. Packaged source, dependencies, update feed and the `deb` updater marker match the release.
- **Linux AppImage:** the published 0.7.6 AppImage performs a real check, download, installation and automatic relaunch into 1.0.0 through an isolated local update feed. Downloaded and installed SHA-256 values match the release artifact. Domain rules, saved server, bookmark, cookie and update preference survive. Both old and relaunched processes run as an ordinary user without `--no-sandbox`. The full-download fallback was exercised after the test server rejected multipart range requests.
- **Windows:** the final x64 NSIS installer was installed on Windows 11. Twelve integration groups pass against the installed executable. A separate native-sandbox check verifies the real version/feed, bundled fonts, larger controls, six Settings categories and Library search. The strengthened real-form domain-save test passes with awaited endpoint checks, the actual second server’s content, retained unrelated tabs, the same process/window and no quit event.
- **Mac packages:** both arm64 and x64 ZIP/DMG bundles pass strict recursive signature verification with the existing SolutionMAX identity. CPU architecture, version, bundled icon, packaged source and matching DMG/ZIP app contents were checked. Native packaged routing/TLS smoke tests run with the Chromium sandbox explicitly enabled on both architectures. Nine integration groups pass on each architecture, including Settings/Library, resizing, domain saving, compact controls, workspace, onboarding, Claude session storage, the live extension updater and the original extension worker. Both architectures pass the Claude tests with the native sandbox explicitly enabled; observed Intel renderer arguments also include the native sandbox/seatbelt flags.

The published 0.7.6 Mac arm64 app and Windows x64 installer also passed actual update checks, payload downloads, installation and native relaunch into 1.0.0 through isolated local feeds. Installed payloads match the final release artifacts. The Mac update retained its signing requirement, domain rule and cookie; the Windows update verified the replaced executable and automatic relaunch. Original user profiles are isolated from these tests.

Linux testing uses a virtual display in an Ubuntu container. AppImage execution uses `APPIMAGE_EXTRACT_AND_RUN=1`; FUSE mounting and physical GPU behavior were not tested. Claude tests use disposable profiles and synthetic local tool consent, not a signed-in personal conversation. Mac Intel testing uses Rosetta on Apple Silicon, not a separate Intel machine. Mac builds use the existing SolutionMAX signing certificate, without Apple notarization; Windows installers are unsigned.

The older entries below describe their respective historical releases, including behavior that has since changed. Current routing and SSL behavior is documented in the README and technical notes.

## 0.6.0 — Dioptra rename and logo

Product renamed from Hostlane to Dioptra; app ID and `Migratiebrowser` profile path unchanged. New watchtower app icon (`build/icon.png`, master `build/dioptra-mark.png`) and in-app mark (`src/brand/dioptra.png`) in tab strip, start page and About; the maker card keeps the SolutionMAX logo. The Claude feature-endpoint user-agent filter strips `Dioptra/` as well as the older names. Test env vars are now `DIOPTRA_TEST_EXECUTABLE` and `DIOPTRA_CLAUDE_DEBUG`.

Linux: 30 unit tests, browser, workspace, Claude (root-limited) and Claude session tests pass. Mac: 30 unit tests pass; packaged arm64 passes the full original-worker Claude suite (anchor, Hostfile + Live read/accessibility/screenshot, consent, panel identity, login UI), Claude session and workspace suites. Packaged Intel (x64, via Rosetta) passes the same three suites. Both Mac signatures verify (ad hoc). Checksums in dist/Dioptra-0.6.0-SHA256SUMS.txt. No GitHub publication or OTA installation.

## 0.5.2 — Compare scripting, banners and memory

Reproduced `No tab with id` from Chromium scripting when targeting the separate Live session. The authenticated compatibility bridge runs Live main-frame functions in isolated world 1004 with the installed vendor accessibility helper; ordinary tabs retain native scripting. Explicit MAIN-world execution is supported; Live file/subframe/document-target injections are rejected. Page-world tests cannot see the helper or Node/Hostlane APIs.

Also reproduced the existing-conversation case: create the original Hostfile anchor, enable Compare, then target Live in the same session/group. The new Live tab now inherits the Hostfile tab's existing group. The unmodified original worker passes get_page_text, read_page and computer screenshot on both targets using that same anchor. Vendor consent denial, panel identity and OAuth regressions still pass. Accountless synthetic local-tool fixture only; no signed-in conversation claim.

Source macOS workspace tests pass with actual distinct IPs, isolated cookies, SSL restart, downloads and nonzero app-process memory. Thirty unit tests pass. Refined 48px banners and footer checked in Chromium at 238px pane width and in actual Electron renderer screenshots. Memory is sampled every five seconds via a dedicated event, avoiding periodic full UI rerenders; tooltip states working-set/shared-memory limitations.

Final 0.5.2 arm64 package passes the complete original-worker Compare/hosted/OAuth suite and workspace suite including actual RAM sampling. Both Mac signatures verify; Intel ZIP and Linux AppImage built. Linux source Claude/workspace tests pass, and all 16 packaged Linux source files match tested source. Checksums in dist/Hostlane-0.5.2-SHA256SUMS.txt. No GitHub publication or OTA installation.

## 0.5.1 — Original Claude anchor and tool transport

Reproduced the native Electron internal-message sender bug against the unmodified 1.0.94 worker: its own sidepanel was misidentified as a tab. The narrow internal relay restores Chrome's extension-page sender identity. A native vendor status round trip precedes dispatch to wake the worker and ensure its listeners are ready. Review found no remaining important issues.

Sandboxed macOS source integration passes after reloading the extension without manually warming the worker. The original worker creates the anchor group, extracts page text, returns the accessibility tree and captures a screenshot. The disposable profile seeds synthetic feature/consent values and an API-key marker for the vendor's accountless local-tool path; this does not test a signed-in conversation. Original consent denial and rejection of an unregistered sidepanel are asserted. Existing hosted-frame, OAuth, sandbox and refresh regressions pass; all 30 unit tests pass.

Final 0.5.1 macOS arm64 package passes the complete original-extension integration, cookie/session persistence and comparison/workspace suites. Both arm64 and Intel ad-hoc signatures verify. Linux source Claude integration passes with its documented root-worker limitation; all 16 packaged Linux src JS/CJS/HTML/CSS files match tested source. Mac ZIPs and Linux AppImage built; checksums available in dist. No GitHub publication or OTA installation.

## 0.5.0 — Migration comparison and browser essentials

Thirty unit tests pass on Linux and macOS. Real Chromium comparison tests serve the same hostname on two loopback servers: Hostfile uses ::1, Live uses 127.0.0.1. Assert the different page contents, observed IPs, independent redirects, isolated cookies, failure clearing, two-view geometry, native find shortcut/next/previous, bookmark and download persistence, closed-tab reopening and inactive-peer cleanup. Double Compare requests do not create duplicate peers. The original Claude extension successfully starts a download from a Live tab. Native download progress/pause/resume/cancel and blob downloads are exercised.

SSL tests prove that simply replacing a verification callback does not revoke Chromium's earlier accepted certificate decisions. The shipped setting therefore takes effect only after restart; integration tests verify rejection with strict mode and acceptance with migration bypass across real app restarts. The banner reports the active policy, separately from the saved pending setting. Existing browser routing/TLS/auth/download/DevTools, Claude-session persistence and full sandboxed macOS original-extension/worker/hosted-panel tests pass.

Live telemetry represents active upstream connections for a hostname and port, not an exact per-request TLS tunnel ID. Direct page telemetry uses Chromium's response IP. No configured/DNS-only address is presented as a measured connection. End-to-end vendor account actions remain outside automated fixtures; manual testing confirmed the desired Claude interface works on 0.4.5.

Final distribution checks: both packaged Mac architectures pass the full workspace integration suite, including actual response IPs, failure/blank-page clearing, cached-response labeling, SSL restart policy and browser essentials. Packaged arm64 also passes the original Claude worker/login/hosted-frame suite. Both ad-hoc signatures verify. Linux AppImage built and every packaged src JS/CJS/HTML/CSS file matches the tested source. Root-only Linux packaged launch is not claimed; the source harness supplies the required test-only sandbox override. Files and checksums are in dist/Hostlane-0.5.0-*. No GitHub publication or OTA installation.

## 0.4.5 — Feature-request identity

Unit tests reproduce differing worker/panel headers, then verify consistent client identity, exact endpoint scope, preserved credentials and case-insensitive existing headers. Real Chromium onSendHeaders tests observe normalized platform/version/Chrome identity on an unauthenticated request. No account secrets are used or recorded. Original hosted-panel, OAuth and browser-control regressions remain covered. This verifies request compatibility, not a true rollout flag or Opus 5.5 access for a signed-in account.

All eight unit tests and Linux Claude integration pass. Sandboxed macOS source and final packaged arm64 Claude integration pass, including outgoing request headers and the original extension worker. Both Mac bundle signatures verify. Mac arm64/x64 ZIPs and Linux AppImage built as 0.4.5; no GitHub publication or OTA installation performed.

## 0.4.4 — Hosted Claude panel identity

The original extension worker was exercised from an actual sandboxed HTTPS claude.ai child frame beneath the extension sidepanel. Before the fix, native Electron messaging returned host info without side-panel capabilities. The scoped bridge omits the incorrect sender.tab field for this exact context. Checks cover original ping/host-info responses, panel capabilities, frame reload, OAuth-message rejection, wrong-view denial, sandbox/context isolation and no page-visible Node or Hostlane commands. The remote test HTML is synthetic; authenticated model selection remains an account-level check. The final packaged arm64 Mac app passes the extended suite; both Mac signatures verify. Core/CRX, cookie/session and Linux bridge tests pass.

## 0.4.3 — Claude interface diagnostics

The authenticated user's interface mismatch remains unconfirmed. Added explicit feature-cache refresh and allowlisted diagnostics in Settings → Claude; no account data or full feature payloads are copied. Integration tests verify cached interface flag reporting, exclusion of an unrelated payload value, clipboard output and preference retention on refresh. Linux bridge/session/core checks and sandboxed Mac original-extension checks pass. A new iframe element is reported as selected, not proof that its remote content is ready. No availability flags or model IDs are overridden. Final packaged macOS arm64 integration checks and both Mac signature checks pass. The local HTTPS updater test downloads the 0.4.3 AppImage as a synthetic next version and verifies its SHA512; installation is not invoked.

## 0.4.2 — Claude session sharing and toolbar icon

Real Chromium tests use synthetic cookies to verify strict OAuth → extension cookie sharing, unchanged security/path/domain attributes, rotation, restart, logout, and unrelated-provider isolation. A controlled in-flight rotation/logout race failed before the fix and passes now. macOS also passed a real 0.4.1 packaged app → 0.4.2 source profile transition with an existing strict-session cookie. Browser regression, core/CRX tests and sandboxed macOS original-extension tests pass. The final macOS arm64 package passes both session and original-extension tests; both Mac package signatures verify. The toolbar uses the original Claude icon with an accessible label and tooltip.

The original extension retains ownership of OAuth tokens, expiry, feature gates and reauthentication. An authenticated account re-login was not tested; cookie availability and persistence are verified, not guaranteed account acceptance by Anthropic.

## 0.4.1 — Claude sidebar layout

Removed the installed extension’s extra Hostlane header and 192-pixel management area. Claude fills the sidebar from browser toolbar to footer; controls moved to Settings → Claude. Linux bridge regression and macOS arm64 packaged-app Claude tests pass, including pane bounds, hidden Claude wrapper header and restored Settings header. Both Mac package signatures verify. Manual testing reports successful account login on 0.4.0; this patch leaves the existing profile untouched.


## 0.4.0 — experimental Claude inside Hostlane

- Original Claude 1.0.94 downloaded from Google by the installed macOS arm64 app; CRX3 publisher signature checked. Original payload accepted; a modified payload rejected. Unit test also generates signed/tampered/malformed CRX fixtures.
- Real sandboxed macOS development and packaged-app runs: original login screen and service worker, actual Hostlane tab discovery, groups, page read/click/screenshot, native Chromium script injection, removal, and ordinary-page isolation pass. A test preload from an untrusted page cannot invoke the Claude IPC API.
- Claude's original Log in button creates a tab inside Hostlane using the strict `persist:claude-auth` session. The login-page extension handshake reaches the original worker; an invalid OAuth state is rejected by the original vendor code. No real account credentials or authenticated model conversation were used.
- A local self-signed TLS fixture is accepted by the migration session and rejected by the auth session. Normal browser certificate bypass still passes existing checks, including an unmapped IP URL.
- Linux core/CRX tests, browser regression suite and updater download/hash check pass. The Linux root harness passes the browser API bridge tests but cannot exercise worker preloads because it suppresses the sandbox; macOS checks cover the sandboxed worker path.
- Mac arm64/x64 ZIPs and Linux AppImage built as 0.4.0. Both Mac ad-hoc signatures verify; Intel packaged HTTPS/DNS/sandbox smoke test passes. Tested Linux source matches its packaged ASAR. No Apple notarization, GitHub publication or OTA installation performed.
- Reproduction: `npm test`, `xvfb-run -a npm run test:browser`, `npm run test:claude` on a normal desktop account. Set `CLAUDE_TEST_EXECUTABLE` to a packaged executable to exercise the actual distributed app. For offline extension setup, use `CLAUDE_TEST_EXTENSION_DIR`; the OAuth handshake still accesses Claude's sign-in site.


## 0.3.0 — docking and SolutionMAX branding

- Final Linux and Mac builds completed. Both Mac architectures passed packaged HTTPS/sandbox launch tests and ad-hoc signature verification. The final AppImage update download/hash check passed; actual installation was not invoked. Final Linux packaged source and branding assets were compared with tested source. Checksums: `dist/Hostlane-0.3.0-SHA256SUMS.txt`.

- Core geometry tests pass for bottom/left/right docking, non-overlapping native website/inspector/control areas and narrow windows with a sidebar.
- Real browser tests pass on Linux and macOS: dock buttons, pointer drag from right to left, splitter resizing, Escape cancellation, keyboard resize axis, retained size/position in settings, and the existing routing/auth/download/restart suite.
- Independent review confirmed drag cancellation and settings validation. Minor keyboard/ARIA issues were corrected; the maker website now opens in a new tab to preserve active migration work.
- SolutionMAX logo assets are bundled locally; the app icon is a raster export of the existing company SVG, not an invented replacement. Start-page preview inspected at `artifacts/hostlane-solutionmax.png`.
- Claude extension loading was tested separately with the original unmodified 1.0.94 package in an isolated Linux profile. It fails before presenting a usable UI; this is documented in `docs/experiments/claude-extension.md`. No logged-in Claude session or browser-control action was tested.

## 0.2.0 — Hostlane

- English interface with distinct Domains, Settings and Updates panels. Gear no longer opens the domain editor.
- Core tests pass on Linux; full browser integration passes on Linux and macOS. Integration exercises settings navigation, real embedded DevTools frontend, quick toggles, tab switching, DOM retention, routing, TLS bypass, auth, downloads and profile persistence.
- Independent review reproduced a DevTools timing issue. Fixed by maintaining one inspector per tab and toggling its visibility; eight rapid-toggle cycles passed in the review. Hiding keeps the inspector attached until the tab is closed.
- Performance changes: skip identical settings writes; calculate resolver strings only when rules change; preserve tabs/rules DOM when displayed data is unchanged. No external-page speed benchmark is claimed.
- HTTPS update fixture exercises actual screen buttons, availability, download and downloaded state using the current Hostlane AppImage. SHA512 verification passed. The fixture advertises a synthetic future version, and installation is deliberately not run.
- Final Linux and Mac builds completed. Both packaged Mac architectures passed the HTTPS/sandbox launch test and ad-hoc signature verification. Linux packaged source matches the tested source; release hashes are in `dist/Hostlane-0.2.0-SHA256SUMS.txt`.
- Existing `Migratiebrowser` profile path and app ID are retained through the rename. A fresh profile launch was checked independently.
- GitHub repository/publication explicitly deferred. Runtime feed is empty by default. No valid Mac signing identity is available; Mac automatic installation is not claimed.

## 0.1.1 — website certificate bypass

- Regression test first reproduced `ERR_CERT_AUTHORITY_INVALID (-202)` without any test-only trust override.
- Core tests and real browser integration pass on Linux x64; browser integration also passes on macOS arm64. Self-signed certificates, hostname mismatch and HTTPS fetch work in website tabs; the default session still rejects the untrusted certificate.
- Website bypass is scoped to `persist:web`; no global certificate-ignore flag, sandbox change or OS trust change.
- Linux AppImage/tar.gz and macOS arm64/x64 ZIPs rebuilt as 0.1.1. Both packaged Mac apps passed the HTTPS test with a self-signed, mismatched certificate and sandbox enabled; both ad-hoc signatures verified.
- A specific production migration server was not part of these tests.

## Original 0.1.0 verification


Migratiebrowser 0.1.0 / Electron 44.4.5 / Chromium 152.0.7977.130.

- Core tests pass: domain/IP validation, IPv6, Unicode normalization, duplicate/injection rejection, URL validation, persistence and corrupt-file rejection.
- Real Electron integration passes on Linux x64 and macOS arm64: browser-only DNS overrides, Host header, TLS SNI, certificate rejection, JS, cookies, redirects, fetch, WebSockets, blank popup content, HTTP authentication, downloads, committed URL preservation, web privilege isolation, OS DNS isolation, rule add/delete and restart persistence.
- Packaged macOS arm64 and x64 apps both launched on the Mac mini with sandbox enabled and successfully routed a test domain. x64 was exercised through the Mac's compatibility environment, not separate Intel hardware. Both ad-hoc signatures passed `codesign --verify --deep --strict`.
- Linux AppImage built. Linux integration used a test-only root sandbox harness; shipped source does not contain that bypass. Normal Linux desktop acceptance testing remains useful.
- Updater check and full AppImage download/hash verification passed against a local HTTPS fixture using app code and packaged updater configuration. Development Electron used test-only packaged-state/certificate overrides. Actual installation, public release hosting and Apple notarization were not tested or configured.
- Production dependency audit: zero known vulnerabilities. Four review findings corrected and re-reviewed; auth-dialog cleanup also applied.
- Linux and both Mac packages were compared against their final tested main-process source. Checksums are in `dist/SHA256SUMS.txt`.

No claims of universal Chrome compatibility, Claude/Chrome extensions, DRM or screen sharing. No OS hosts or public DNS changed.
