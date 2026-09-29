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

The Mac preview is ad-hoc signed. macOS automatic installation requires suitable signing; the build machine currently has zero valid Developer ID identities. Until Developer ID signing and notarization are configured, macOS shows the update notice and an **Open download page** button instead of installing in place. Do not bypass signature verification.

Linux AppImage download and SHA512 verification have been exercised against a local HTTPS fixture. The tar.gz distribution is updated manually. The test advertises a synthetic future version carrying the current AppImage, verifying download transport/integrity, not an actual version upgrade or installation.

The workflow in `.github/workflows/build.yml` runs on demand (Actions → Run workflow). It builds and tests artifacts only; it does not publish a release.
