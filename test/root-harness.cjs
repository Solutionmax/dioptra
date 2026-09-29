// Test-only: CI runs as root, so Chromium requires --no-sandbox.
// Not shipped: the packaged app always enables its sandbox.
require('electron').app.enableSandbox = () => {};
