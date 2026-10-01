# Dioptra release and update setup

Since 0.7.0 the default update feed is `https://github.com/Solutionmax/dioptra/releases/latest/download/` (GitHub Releases). A custom HTTPS feed can still be set under Settings → Updates. The feed only works while the repository is public; release downloads from a private repository require authentication, which the app deliberately does not embed.

## Local behavior

Settings → Updates provides check, version/release notes, progress, download and install/restart confirmation. Automatic checks are on by default (10 seconds after startup, then every four hours) and can be turned off. When an update is available, a notice replaces the old PREVIEW badge in the tab strip. Website certificate exceptions do not apply to updater traffic.

## Publishing a release

1. Bump the version in `package.json`.
2. Update `build.publish.url` if needed and build/test both platforms. Builds use `--publish never`.
3. Publish AppImage, Mac ZIPs and blockmaps with `latest-linux.yml` and `latest-mac.yml`. Keep both Mac architectures in the Mac metadata; Electron Updater selects the compatible artifact. Publish metadata only once referenced artifacts exist, preferably by publishing a complete draft release.
4. Attach `SHA256SUMS.txt`.
5. Test a real old-version → new-version installation on each target OS and verify profile preservation.

Since 0.7.2 the Mac builds are signed with SolutionMAX's own code signing certificate (not issued by Apple). Every build carries the same identity, so the in-app updater accepts the next version and macOS installs it. The builds are still not notarized: the first manual install needs **Open Anyway** once. Build with `DIOPTRA_SIGN_IDENTITY` (SHA-1 of the certificate) and optionally `DIOPTRA_SIGN_KEYCHAIN`; without them `scripts/sign-mac.cjs` signs ad hoc and such a build cannot update itself on macOS.

Linux AppImage download and SHA512 verification have been exercised against a local HTTPS fixture. The tar.gz distribution is updated manually. The test advertises a synthetic future version carrying the current AppImage, verifying download transport/integrity, not an actual version upgrade or installation.

The workflow in `.github/workflows/build.yml` runs on demand (Actions → Run workflow). It builds and tests artifacts only; it does not publish a release.
