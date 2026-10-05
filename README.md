<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/logo-dark.png">
    <img src="docs/screenshots/logo.png" width="96" height="96" alt="Dioptra logo">
  </picture>
</p>

<h1 align="center">Dioptra</h1>

<p align="center"><b>Same domain. Different server.</b><br>
A browser for website migrations: open any site on its new server before DNS changes, compare it with the live site, and spot what is different.</p>

<p align="center">
  <a href="../../releases/latest"><b>Download</b></a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#install">Install</a> ·
  <a href="docs/technical-notes.md">Technical notes</a>
</p>

![Dioptra comparing the new server (Hostfile) with the live site side by side](docs/screenshots/compare.png)

## Why Dioptra

Moving a website to a new server usually means editing `/etc/hosts`, flushing DNS, and guessing which server you are actually looking at. Dioptra does this inside one browser window instead:

- **Domain rules, only in this browser.** Point `example.com` to your new server's IP. Your system hosts file, other browsers and colleagues are not affected.
- **Always know where you are.** The route bar shows the rule, the IP you are really connected to with its reverse DNS name, the certificate state and the HTTP status.
- **DNS records at a click.** The A, AAAA, CNAME, MX, TXT and NS records of the domain. In Compare the zone on the new server sits next to public DNS, so a mail or TXT record that did not come along shows up before you switch.
- **See what the site runs on.** WordPress, WooCommerce, Drupal, Laravel and more, with the PHP version when the server reports it. In Compare a different PHP version on the old and new server is marked.
- **Compare.** The new server and the live site side by side, each with its own cookies. Or put another URL on the right, such as the copy of a site on a temporary test domain. Drag the bar between the panes to give one side more room.
- **Differences.** Dioptra fetches the page from both servers and shows what changed in the HTML, the headers and the external domains the page loads. Injected scripts and other signs of a hacked site stand out immediately.
- **Claude built in.** Install the official Claude in Chrome extension and let Claude read, click and screenshot your tabs, including both sides of a comparison.
- **Made for testing servers.** Certificate errors on a new server can be skipped, while Claude and sign-in services always keep strict certificate checks.

## Download

| Platform | File |
| --- | --- |
| macOS, Apple silicon (M1 and later) | `Dioptra-<version>-mac-arm64.zip` |
| macOS, Intel | `Dioptra-<version>-mac-x64.zip` |
| Windows 11 and 10, 64 bit | `Dioptra-<version>-win-x64.exe` |
| Linux x86-64 | `Dioptra-<version>-linux-x86_64.AppImage` |

Get the files from the [latest release](../../releases/latest). Each release includes a `SHA256SUMS.txt` file.

## Install

### macOS

1. Unzip the file and move **Dioptra** to **Applications**.
2. Open Dioptra. The app is not yet notarized by Apple, so the first time macOS says it cannot verify the app.
3. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the Dioptra message. You only need to do this when you install by hand; updates installed from inside Dioptra open without it.

Prefer the terminal? This removes the download quarantine flag instead:

```sh
xattr -dr com.apple.quarantine /Applications/Dioptra.app
```

### Windows

1. Run `Dioptra-<version>-win-x64.exe`.
2. The installer is not signed yet, so Windows shows **Windows protected your PC**. Click **More info** and then **Run anyway**.
3. Dioptra installs for your user only, without administrator rights, and starts when it is ready. You find it in the Start menu and on the desktop.

Updates installed from inside Dioptra do not show the warning again. Tested on Windows 11.

### Linux

```sh
chmod +x Dioptra-*-linux-x86_64.AppImage
./Dioptra-*-linux-x86_64.AppImage
```

Run it as a normal user. If FUSE is not available, add `--appimage-extract-and-run`.

## How it works

### 1. Add a domain rule

Open **Domains**, enter the domain and the IP address of the new server (IPv4 or IPv6), then choose **Apply and restart**. Rules match the exact domain name, so add `www` and other subdomains separately. You can switch rules on and off without deleting them.

![Domains panel with three domain rules](docs/screenshots/domains.png)

### 2. Browse the new server

Type the normal address. The blue **HOSTFILE** badge in the route bar means the page came from your rule. The bar shows the rule IP, the IP Dioptra actually connected to (with a match check) and the reverse DNS name of that IP, the certificate state and the HTTP status with load time. Pages without a rule show a green **LIVE** badge.

![Single view with the route bar showing Hostfile, rule IP, connected IP and certificate state](docs/screenshots/single.png)

Four things in the window open a small card with details:

- **Certificate valid** (with SSL verification on): who the certificate was issued to, the issuer and the expiry date with the days left.
- **Site**: the platform Dioptra recognised, shop, theme, plugins that are visible in the page, PHP version and web server. This is read from what the page itself gives away (generator tag, file paths, cookie names, headers). When nothing is recognised, nothing is shown.
- **DNS** (next to the domain name): the A, AAAA, CNAME, MX, TXT and NS records that public DNS gives for the name you are visiting, plus its `www` name. Nothing is looked up until you click, and **Refresh** asks again.
- **RAM** in the footer: memory per tab, so you can see which site is heavy. Click a tab to jump to it.

![Certificate card with issuer and expiry date](docs/screenshots/certificate.png)

![Site card showing WordPress, WooCommerce, theme, plugins, PHP version and web server](docs/screenshots/site.png)

![DNS card with the public records of the domain](docs/screenshots/dns.png)

![Memory card listing memory per tab](docs/screenshots/memory.png)

### 3. Compare with the live site

Click **Compare**. The left pane is the new server through your rule, the right pane is the live site through normal DNS. Each pane has its own route bar and its own temporary cookies. Click a pane to use the address bar, back, forward and find in that pane.

To compare with a different address, click the domain in the right pane bar and type the other URL, for example the copy of the site on a temporary test domain. **Same URL** puts the right pane back on the page of the left pane. Compare also works on a site without a domain rule: the right pane then asks which address to compare with. The right pane always uses normal DNS, so a site that is only reachable through a rule goes on the left. Differences is available when both panes are on the same site.

Drag the bar between the two panes to make one side larger, for example to see the desktop layout of the new server next to a narrow live site. Each pane keeps at least a quarter of the width. As soon as the panes are not equal a small button appears between the pane bars: one click makes them equal again, and so does a double click on the bar. The position is remembered.

![Compare view with Hostfile on the left and Live on the right](docs/screenshots/compare.png)

The **DNS** button in either pane puts the DNS records side by side: what the new server answers when Dioptra asks it directly, and what public DNS says. Values that exist on one side only are marked, so a mail or verification record that is missing on the new server stands out. The address record is expected to differ during a migration and is labelled that way. This works when the new server runs its own DNS, as cPanel, DirectAdmin and Plesk servers do. When it does not, the card says so and shows public DNS.

![DNS records of the new server next to public DNS](docs/screenshots/dns-compare.png)

### 4. See the differences

Click **Differences**. Dioptra downloads the page from both servers and compares:

- **External domains:** which hosts the page loads scripts, stylesheets, images and frames from, and which ones appear on only one side.
- **HTML:** the changed lines, with a little context.
- **Headers:** server software, PHP version, caching and security headers that differ.
- **Findings:** a plain-language summary, with serious items in red, such as a script that loads only on the live site or inline code that looks obfuscated.

Compare shows you whether both sides *look* the same. Differences shows what the servers actually *send*, so it also catches things you cannot see, like hidden malware or SEO spam.

![Differences view listing a script that loads only on the live site](docs/screenshots/differences.png)

![HTML tab of the Differences view showing an obfuscated script that only exists on the live server](docs/screenshots/differences-html.png)

**Ask Claude about these differences** copies a summary to the clipboard and opens the Claude panel, so you can paste it and ask Claude what to fix. The summary marks everything that came from the servers as untrusted data.

### 5. Settings

- **Verify website SSL certificates:** off by default so test servers with self-signed or mismatched certificates still open. Turn it on for strict checking (applies after a restart).
- **Clear cache** (footer): clears the cache and DNS cache and reloads the page, in Compare both panes. Cookies and logins are kept.
- **Clear site data:** removes cookies, storage, service workers and cache for the current site only. Handy when an old session hides what the new server does. Claude and sign-in services are never cleared this way.
- **Bookmarks, history and downloads** live under the Library button in the toolbar.
- **Developer Tools** open inside the window and can be docked left, right or below (F12).

![Settings panel with SSL verification, Clear site data and updates](docs/screenshots/settings.png)

### Updates

The footer shows the installed version. Dioptra checks for new releases at startup and every four hours; nothing installs by itself. When an update is available, the footer and a notice at the top right tell you. Click either to open **Updates**, choose **Download update** and then **Install and restart**. This works on Linux and Windows and, from 0.7.2, on macOS. Coming from 0.7.0 or 0.7.1 on macOS you update by hand one last time: download the zip from the release page and replace the app. You can turn automatic checks off in **Settings → Updates**.

![Updates panel with the installed version and how updates work](docs/screenshots/updates.png)

### Claude

Click the Claude icon, choose **Install Claude**, and sign in with your Claude account (a paid plan is required by the extension). Dioptra downloads the official extension from Google's update service and verifies its signature before installing it. Claude can then work with your Dioptra tabs. This integration is experimental: Dioptra is not Google Chrome, and some Chrome features are not available. See [technical notes](docs/technical-notes.md) for details.

## Privacy and security

- Dioptra never edits your system hosts file or proxy settings.
- The Live side of a comparison uses a separate, temporary session that is removed when you close the app.
- DNS records are looked up only when you click the DNS button. In Compare the server from your rule is asked directly on port 53.
- Differences requests are sent without your cookies. Reports never include cookies or authorization headers.
- Websites run in Chromium's sandbox with context isolation. Claude, Anthropic and common sign-in providers always keep certificate verification.

## Build from source

Requires Node.js 22 or later.

```sh
npm ci
npm start                 # run from source
npm test                  # unit tests
npm run test:browser      # real browser flow (use xvfb-run on a headless Linux machine)
npm run dist:mac          # macOS zips for Apple silicon and Intel
npm run dist:linux        # Linux AppImage
npm run dist:win          # Windows installer (on Linux this needs wine, for example the electronuserland/builder:wine image)
```

## Support the work

Dioptra is free and MIT licensed. If it saved you a migration headache, you can [buy me a coffee](https://buymeacoffee.com/solutionmax). It helps pay for the Apple Developer ID, so future macOS builds open without the security warning.

## License

[MIT](LICENSE) © 2026 [SolutionMAX](https://solutionmax.net)
