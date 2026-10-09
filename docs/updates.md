# Dioptra release and update setup

Since 0.7.0 the default update feed is `https://github.com/Solutionmax/dioptra/releases/latest/download/` (GitHub Releases). A custom HTTPS feed can still be set under Settings → Dioptra updates. The feed only works while the repository is public; release downloads from a private repository require authentication, which the app deliberately does not embed.

## Local behavior

Settings → Dioptra updates provides check, version/release notes, progress, download and install/restart confirmation. Automatic checks are on by default (10 seconds after startup, then every four hours) and can be turned off. When an update is available, a notice replaces the old PREVIEW badge in the tab strip. Website certificate exceptions do not apply to updater traffic.

## Publishing a release

1. Bump the version in `package.json`.
2. Update `build.publish.url` if needed and build/test Mac Apple silicon, Mac Intel, Linux AppImage, Ubuntu/Debian amd64 and Windows x64. Builds use `--publish never`.
3. Publish AppImage, Ubuntu/Debian `.deb`, Mac DMGs and ZIPs, Windows installer and blockmaps with `latest-linux.yml`, `latest-mac.yml` and `latest.yml`. The Linux metadata must reference both the AppImage and `.deb`. Keep both Mac architectures in the Mac metadata; Electron Updater selects the compatible artifact. Publish metadata only once referenced artifacts exist, preferably by publishing a complete draft release.
4. Attach `SHA256SUMS.txt`.
5. Test a real old-version → new-version installation on each target OS and verify profile preservation.

Since 0.7.2 the Mac builds are signed with SolutionMAX's own code signing certificate (not issued by Apple). Every build carries the same identity, so the in-app updater accepts the next version and macOS installs it. The builds are still not notarized: the first manual install needs **Open Anyway** once. Build with `DIOPTRA_SIGN_IDENTITY` (SHA-1 of the certificate) and optionally `DIOPTRA_SIGN_KEYCHAIN`; without them `scripts/sign-mac.cjs` signs ad hoc and such a build cannot update itself on macOS.

The 1.0.0 Linux AppImage passed a real update from the published 0.7.6 package using an isolated local feed: download integrity, installation, automatic relaunch and profile preservation were verified. Ubuntu/Debian uses the packaged `package-type` marker to select DebUpdater and the system package manager; installation may require administrator authentication. The 1.0.0 `.deb` was installed with apt on Ubuntu 24.04 and tested as an ordinary user. See [verification](verification.md) for platform coverage and test limits.

The published 0.7.6 Mac arm64 and Windows x64 packages also passed actual download/install/relaunch updates to 1.0.0 through isolated local feeds. Mac update signatures retain the existing signing requirement.

The workflow in `.github/workflows/build.yml` runs on demand (Actions → Run workflow). It builds and tests artifacts only; it does not publish a release.
