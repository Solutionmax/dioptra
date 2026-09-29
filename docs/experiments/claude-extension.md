# Claude in Chrome compatibility experiment — 2026-09-29

Hostlane 0.3.0 development source; Electron 44.4.5 / Chromium 152.0.7977.130; Linux x64 under the test-only root harness.

Downloaded the original Chrome Web Store CRX for extension `fcoeoabgfenejglbffodgkkbkcdhcgfn` (Claude 1.0.94) using Google's extension-update endpoint. Extracted the original archive without modifying extension source, and loaded it into an isolated persistent Electron session with a temporary profile. Opened its original `sidepanel.html` in a sandboxed WebContents. No user account was used.

## Observed result

- `session.extensions.loadExtension()` succeeds and retains the original extension ID.
- The side panel remains blank.
- Its service worker and side-panel code both report `Uncaught TypeError: Cannot read properties of undefined (reading 'Color')` from `assets/mcpPermissions-tSjXinpi.js`.
- Runtime probes in the extension show `chrome.sidePanel`, `chrome.debugger`, `chrome.tabGroups` and `chrome.identity` are undefined. `chrome.tabs`, `chrome.scripting`, `chrome.offscreen` and `chrome.runtime.connectNative` exist, but existence does not establish full compatibility.
- The manifest requests those missing capabilities alongside native messaging, web navigation, downloads, alarms and other APIs.

Therefore installation/loading alone does not produce a usable Claude browser extension in this Electron version. This is a measured failure, not merely an assumption based on lack of official support. No extension payload is bundled with Hostlane; no misleading "Claude supported" installer was added. The experiment's downloaded files remain in `/tmp/hostlane-claude-extension`, and the local probe/result files are `/tmp/hostlane-claude-probe.cjs` and `/tmp/hostlane-claude-probe-result.json`.

Getting browser control working would require substantial extension-API compatibility work or a separate, permission-aware Claude integration. Authentication, native messaging with Claude Desktop, and browser actions were not tested because the unmodified extension fails before presenting its UI.

Sources: [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions/), [Claude Chrome Web Store listing](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn), [Anthropic supported-browser guidance](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome).

## Follow-up: resolving the first startup exception

In a separate temporary copy (`/tmp/hostlane-claude-patched`), supplied Chrome's tab-group color constants and `TAB_GROUP_ID_NONE`. The original downloaded extension was preserved. Repeated the same isolated runtime probe: the initial `Color` exception disappears, but both the service worker and side panel immediately fail on `Cannot read properties of undefined (reading 'onEvent')`, accessing the missing debugger API. The panel remains blank. Results: `/tmp/hostlane-claude-patched-result.json`.

This confirms that patching constants is insufficient. No placeholder debugger or successful-looking stub was added to the application. Browser actions and authentication remain untested. Inspected the existing `electron-chrome-extensions` package (4.9.0); its advertised API implementation does not supply the missing debugger, side-panel, identity and tab-group functionality required here. It was not installed.

Google Chrome 154.0.8037.58 is installed on the development Mac. A dedicated Chrome migration profile is an alternative under discussion, not an implemented Hostlane feature or a verified Claude workflow. Choosing that route would move browser control into Chrome; it must not be presented as control of Hostlane tabs.

## Superseded by the 0.4.0 integration

The unmodified extension still cannot run in stock Electron. Hostlane now supplies the missing APIs through an origin-checked preload in extension frames and its service worker, backed by real Hostlane tabs and Electron's debugger. No vendor JavaScript is modified or bundled. The verified original CRX installs on demand.

The real sandboxed Mac run now reaches the original Log in UI, receives responses from the original background worker, and passes tab/group/read/click/screenshot/script-injection checks. Fresh Google download and verified extraction also pass. An authenticated account conversation and model-driven tools remain unverified. Native Desktop pairing and multiple windows are unsupported. See `test/claude.cjs` and README for reproducible checks.

The Linux test-only root harness suppresses `app.enableSandbox()`. Worker preloads require Electron's sandboxed renderer; that explains the root-only worker startup failure. Production still enables the sandbox.

The strict OAuth session has an exact-origin external-message bridge for Claude’s ping, OAuth redirect and host-info messages. Actual packaged Mac verification passes its ping and original invalid-state rejection. Worker IPC is registered on `ServiceWorkerMain.ipc`, independently of `ipcMain`.
