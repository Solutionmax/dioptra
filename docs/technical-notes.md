# Dioptra technical notes

Detailed behaviour notes collected per release. For installation and everyday use, see the [README](../README.md).

A migration browser for macOS, Windows and Linux, created by **SolutionMAX**. Map a domain to a test-server IP without changing your system hosts file or other browsers.

## Install

- Apple Silicon: unzip `Dioptra-1.0.0-mac-arm64.zip`, then move Dioptra to Applications.
- Intel Mac: use `Dioptra-1.0.0-mac-x64.zip`.
- Linux x64: make `Dioptra-1.0.0-linux-x86_64.AppImage` executable and launch it as a normal user. If FUSE is unavailable, use `--appimage-extract-and-run` or install the Ubuntu/Debian amd64 `.deb`.

Mac releases use the persistent SolutionMAX signing identity for updates, but are not Apple Developer ID signed or notarized. If macOS blocks opening, use System Settings → Privacy & Security → Open Anyway after attempting to open it. Do not disable Gatekeeper globally. Linux desktop sandbox requirements depend on the distribution; do not run the browser as root.

Quit Migratiebrowser or Hostlane before launching Dioptra. The application ID and original `Migratiebrowser` profile directory are retained, preserving domain rules, tabs, cookies and logins. Keep only the app version you intend to use.

## Use

1. Open **Domains** and add the exact domain and IPv4/IPv6 address. Use Include WWW for the matching www alias; add other subdomains separately.
2. Save the rule. Affected pages reload immediately; the app, other tabs and website storage stay open.
3. Navigate to the original domain. The top route bar shows **NEW SERVER** or **LIVE**, observed IP and reverse DNS. Site info shows connection and certificate details.
4. Open **Developer Tools** or press F12 to inspect the page inside the window. Drag the inspector handle to dock left, right or below, or use its docking buttons. Drag the dividing border to resize; Escape cancels a drag. Dock and size persist after restart. The focused separator also supports arrow keys. Each tab has its own inspector. Hiding the panel retains the debugging session until the tab closes.
5. The gear opens **Settings**, separate from domain rules. **Settings → Dioptra updates** opens update status, release notes, download progress and installation controls.

Certificate verification is on. Domain rules can explicitly skip certificate errors on their new-server route; this applies immediately to the rule and its enabled WWW alias. Live, Claude, account services and updater requests remain strict. Website sandboxing and web security remain enabled. System proxy settings are bypassed within Dioptra so they cannot bypass domain mappings.

## Compare Hostfile and Live

Open a website with an applied domain rule, then click **Compare**. The left pane uses Dioptra domain rules; the right pane uses normal OS DNS, bypassing all Dioptra rules. Blue **NEW SERVER** and green **LIVE** banners show each route and its observed IP. Click either page or its banner to use that pane with the address bar, back/forward, reload and find. Navigate each independently. Click **Single** to return to one pane. Opening Developer Tools returns the selected pane to a full-width view.

The Live side has separate, temporary cookies/storage and a TCP tunnel bound only to this computer's loopback interface. HTTPS certificates and encryption remain handled by Chromium. It follows the system's normal DNS/hosts configuration. It does not use the operating system proxy. Dioptra never edits the system hosts file.

For direct pages, the IP comes from Chromium's actual page response. Live IPs are observed remote endpoints of active server connections for the displayed hostname/port; multiple connections may yield multiple IPs (see the banner tooltip). They are not DNS guesses. Cached responses, service-worker responses or unavailable network measurements are shown explicitly without inventing an IP. A CDN address identifies the contacted edge, not necessarily the origin server behind it.

## Browser essentials

- **Cmd/Ctrl+F** searches the selected page; Enter/Shift+Enter or the arrow buttons move between matches. Escape closes find.
- **☆ / Cmd/Ctrl+D** saves or removes a bookmark. **Library** opens bookmarks, history and downloads.
- **Cmd/Ctrl+Shift+T** reopens a recently closed tab in the current app session.
- Downloads show progress, pause/resume, cancel and **Show in folder**. Finished records persist; downloads interrupted by quitting must be started again.
- Library history can be cleared independently. Storage is local and bounded (500 bookmarks, 1,000 recent URLs, 100 downloads). Recognized authentication callbacks/token URLs are excluded from history and bookmark storage; sensitive or blob download source URLs are omitted from records.

## Performance

Unchanged settings are not rewritten on navigation events. Resolver rules are computed when rules change, rather than on every UI update. Tabs and domain lists retain their DOM while displayed data remains unchanged. These reduce application work; they are not a claim that every external website loads faster.

## Updates

The update screen supports HTTPS feeds, release information, download progress and restart/install confirmation. Optional checks run at startup and every four hours. App and Chromium update together.

The default feed is the public Solutionmax/dioptra GitHub release. See [release setup](updates.md). Private beta builds explicitly disable this feed; the v1.0.0 release enables it.

The Linux AppImage update check and download/hash verification have been tested against a local HTTPS fixture. Installation is not yet end-to-end verified. macOS OTA uses the same SolutionMAX signing identity across releases. Apple notarization remains unavailable; initial manual installation can require Open Anyway.

## Extensions

Claude has an experimental built-in installer and compatibility layer; see below. Other Chrome Web Store extensions are not supported. Earlier stock-Electron failures remain documented in [the experiment report](experiments/claude-extension.md).

## Develop

Requires Node.js 22.12+, npm, and OpenSSL for HTTPS tests.

```sh
npm ci
npm start
npm test
npm run test:browser                # macOS / Linux desktop
npm run test:workspace              # comparison, IPs, SSL, browser essentials
xvfb-run -a npm run test:browser     # Linux CI
npm run dist:linux
npm run dist:mac                    # run on macOS
xvfb-run -a node test/update.cjs     # after Linux build
```

The Linux root harness exists only in tests and is not packaged. Test profiles are temporary. Use `--profile-dir=/absolute/path` for an isolated manual test profile.

Settings: `~/Library/Application Support/Migratiebrowser/settings.json` on macOS; `~/.config/Migratiebrowser/settings.json` on Linux. Corrupt settings are never silently overwritten.

## What is still missing?

See [the prioritized browser gap report](browser-gaps.md) for migration tools, everyday browsing features and remaining distribution work.

## Claude inside Dioptra (experimental, 0.4.0)

Click the **Claude icon → Install Claude**. Dioptra downloads the original extension from Google's HTTPS update service and verifies its CRX3 signature and publisher ID before extracting it into your profile. Sign in through the extension's **Log in** button; a paid Claude account is required. The Claude pane stays inside Dioptra. **Open Claude**, **Claude settings**, and **Remove Claude** are under **Settings → Claude**. The installed extension fills the sidebar without a second Dioptra header.

The compatibility layer connects Claude's browser APIs to actual Dioptra tabs: tab queries, navigation, logical groups, script injection, debugger input, page reading and screenshots. Account traffic keeps certificate verification. Claude sign-in uses a separate persistent session with normal certificate checks, including third-party sign-in providers. Claude/Anthropic and common account-provider hosts are also always verified in browser tabs; other websites bypass certificate errors only when their matching enabled domain rule explicitly requests it.

Verified with original Claude 1.0.94 on sandboxed macOS: online installation, original login UI and background worker, tab discovery, page reading/clicking/screenshots, native script injection, removal and isolated page privileges. A complete signed-in conversation and Claude-generated tool call still require an account test. This is experimental compatibility, not official Anthropic support. Separate browser windows and Claude Desktop/native-host pairing are not supported. Future extension versions may require compatibility changes.

Run `npm run test:claude` on a normal desktop user account to test an actual Web Store installation. For an existing unpacked official extension, set `CLAUDE_TEST_EXTENSION_DIR` to its directory. The Linux root harness only tests the bridge, because it disables the sandbox required by Electron service-worker preloads.

Claude login cookies are shared between the extension and the strict sign-in session, including existing profiles upgraded to 0.4.3. Logout and cookie expiry remain effective. Dioptra does not store your password or extend the extension’s token lifetime.

If Chrome and Dioptra show different Claude interfaces, use **Settings → Claude → Troubleshooting → Reload Claude** to reload the panel and fetch its interface settings again (save any draft first). It clears only the feature cache, not your sign-in or preferences. Then use **Check connection → Technical details → Copy diagnostics**. The report contains only extension/app versions, interface/cache flags, permission consent, fixed interface signals and status/error codes for two specific requests. It excludes cookies, tokens, account details, chats and full feature payloads. No model or server-side availability flag is overridden.

In 0.4.4, the hosted Claude panel receives the correct Chrome side-panel identity when contacting the original extension worker. The narrow bridge runs only in the sandboxed Claude view and its claude.ai child frame. Refreshing the hosted page preserves this connection.

Version 0.4.5 aligns the extension worker and panel request identity for the Claude feature-configuration endpoint: missing official client platform/version headers are filled and the Electron/Dioptra user-agent suffixes are removed for that endpoint only. Authentication and feature response values remain owned by Claude. After upgrading, use **Refresh Claude** to discard the prior interface cache.


In 0.5.2, Claude can read and capture the Live pane in Compare. Opening Compare during a conversation keeps the new pane in that conversation's tab group. Live DOM execution uses an isolated world with the original extension's accessibility helper; cookies and DNS remain separate. Live script injection currently supports main-frame functions (including explicit MAIN-world functions), not extension files or subframe/document targeting. Normal Hostfile tabs retain Chromium's native injection behavior.

The connection banners distinguish Hostfile and Live with blue/green badges and selected-pane indicators. Hover for full domain, configured/observed IP and SSL details. The bottom-right **Dioptra RAM** indicator samples the app's process working sets every five seconds; its tooltip shows tab/process counts. Shared memory may be counted more than once, so it is an estimate of app memory rather than total system RAM.
