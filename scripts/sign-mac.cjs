// Signs the macOS app for electron-builder (build.mac.sign).
// Without DIOPTRA_SIGN_IDENTITY the app is signed ad hoc, as before. With it (the SHA-1 of a code signing
// certificate, optionally DIOPTRA_SIGN_KEYCHAIN) every build carries the same identity, which is what the
// in-app updater on macOS needs: it only accepts an update signed by the same identity as the running app.
// signApp returns a promise; the older sign() is callback style and would let packaging continue before signing is done.
const { signApp: sign } = require('@electron/osx-sign');

module.exports = async function signMac(options) {
  const identity = process.env.DIOPTRA_SIGN_IDENTITY;
  if (!identity) return sign({ ...options, identity: '-' });
  return sign({
    ...options,
    identity,
    keychain: process.env.DIOPTRA_SIGN_KEYCHAIN || options.keychain,
    // The certificate is our own, not issued by Apple, so it cannot be validated against Apple's chain.
    identityValidation: false,
    // Hardened runtime only matters for notarization and would block loading the bundled frameworks without a team id.
    optionsForFile: file => ({ ...(options.optionsForFile?.(file) || {}), hardenedRuntime: false })
  });
};
