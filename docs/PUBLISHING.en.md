[Қазақша](PUBLISHING.kk.md) · [Русский](PUBLISHING.md) · [English](PUBLISHING.en.md)

# Publishing to GitHub Pages

The app and the question banks are published separately, each from its own repository:

- The banks repository is turned into a static site with `index.json`, `nodes/` and `banks/`.
- The app is built without embedded content and downloads the banks from that site's address when it starts.

The repository addresses in this document are placeholders. Below, `<user>` is your GitHub account or organization, and `<banks-repo>` and `<code-repo>` are the names of your repositories. The project's own banks address is stored in `content-sources.json` in the root of the code repository; if you publish your own copy, replace it with yours.

## What you need first

- Two GitHub repositories: one with the code (`exam-platform`) and one with the banks (`exam-content`). The banks template below fetches the command line from the code repository; if the code repository is private, you need an access token.
- In the settings of each repository: Settings, Pages, Source: GitHub Actions.
- The app page loads content only from `https://*.github.io` and `https://cdn.jsdelivr.net` (the CSP in `apps/ui/index.html`). For a site on your own domain, add the domain to `connect-src` in that file and rebuild the app.
- The banks host must allow reading files from another origin (CORS), because the app is hosted at a different address. After the first publication, open the app and check the browser console: a CORS error means the host does not allow it.

## Check before publishing

From the root of the code repository, run these against your banks folder (use your own path):

```bash
node packages/content-tools/src/cli.ts validate <banks-folder>
node packages/content-tools/src/cli.ts compile <banks-folder> <output-folder>
```

`validate` prints the number of banks and questions, or a list of errors. `compile` validates the content itself and writes nothing if there are errors. Before the build, `compile` erases the output folder, so that folder must not be inside the banks folder, contain it, or be the same as it. It erases only an empty folder or a previous build (nothing inside but `nodes`, `banks`, `index.json`); with any other folder the command stops and deletes nothing.

## Publishing the banks

The banks repository is published as a whole: the workflow validates the content, builds it with the `compile` command and deploys the result to Pages. The site root is the folder with the build output, so the address for the app is:

```
https://<user>.github.io/<banks-repo>
```

Template `.github/workflows/pages.yml` for the banks repository.

> The template has not been run. Substitute your own repository addresses and check the action versions against the current ones.

```yaml
name: Publish content

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      # The banks are in the root of this repository; put them in the content subfolder.
      - uses: actions/checkout@v4
        with:
          path: content

      # The code is needed only for the command line. Substitute your own code repository.
      - uses: actions/checkout@v4
        with:
          repository: <user>/<code-repo>
          ref: main
          path: code

      - uses: actions/setup-node@v4
        with:
          node-version: 26

      - name: Install the command line
        working-directory: code
        run: npm ci

      - name: Validate
        run: node code/packages/content-tools/src/cli.ts validate content

      # The site folder sits next to content, not inside it: compile erases the output folder.
      - name: Compile
        run: node code/packages/content-tools/src/cli.ts compile content site

      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site
      - id: deployment
        uses: actions/deploy-pages@v4
```

After the first run, open `https://<user>.github.io/<banks-repo>/index.json`. The response must be JSON with the fields `version`, `kinds` and `roots`.

## Publishing the app

The app is built without embedded content (`EXAM_CONTENT_DIR=none`) and with the address of the banks site. The address is in `content-sources.json` at the root of the code repository (the `urls` field), and the `VITE_CONTENT_URLS` variable replaces it for a single build. Both are read at build time and baked into the code, so changing the address requires a new build. The result is in `apps/ui/dist`. Paths in it are relative, so the site also works in the `/<code-repo>/` subfolder. Page addresses use `#`, so you do not need to set up redirects.

Locally, from the root of the code repository:

```bash
EXAM_CONTENT_DIR=none VITE_CONTENT_URLS=https://<user>.github.io/<banks-repo> npm --prefix apps/ui run build
```

In PowerShell:

```powershell
$env:EXAM_CONTENT_DIR = "none"
$env:VITE_CONTENT_URLS = "https://<user>.github.io/<banks-repo>"
npm --prefix apps/ui run build
```

Template `.github/workflows/pages.yml` for the code repository.

> The template has not been run. Substitute your own repository addresses and check the action versions against the current ones.

```yaml
name: Publish app

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: npm

      - run: npm ci

      - name: Build the app without embedded content
        run: npm --prefix apps/ui run build
        env:
          EXAM_CONTENT_DIR: none
          # The address of the banks site (without a trailing slash). Substitute your own.
          VITE_CONTENT_URLS: https://<user>.github.io/<banks-repo>

      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: apps/ui/dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

The app will be available at `https://<user>.github.io/<code-repo>/`.

## How data is updated

- Editing a bank: commit to the banks repository, and the workflow rebuilds the site. When the app starts, it re-reads `index.json` without the cache, sees the new version and downloads only the files whose hash changed. You do not need to rebuild the app.
- Changing the address of the banks site or adding a second mirror: edit `content-sources.json` (or `VITE_CONTENT_URLS` for a single build) and rebuild the app.
- The banks addresses do not respond: the app shows the last saved catalog with the notice "No connection, showing saved data" and reads previously opened banks and nodes from the cache. If nothing is saved on the device, it takes `index.json` from the embedded snapshot, with the same notice. In a build without a snapshot (`EXAM_CONTENT_DIR=none`), the first launch without a network shows a loading error.

## Windows installer

The desktop version is built with `npx tauri build` from `apps/desktop` and runs the same interface build. If you need an installer with the banks embedded, build it without `EXAM_CONTENT_DIR=none`: the content comes from the neighboring `exam-content` folder or from the `EXAM_CONTENT_DIR` variable. With `VITE_CONTENT_URLS`, the installer can update the banks over the network.

## Windows and Android links in the web version

The web version shows links to the installers in a line under the subject list and in the "App" card in the settings. The Windows and Android apps do not show these links. On an Android phone the Android link comes first.

The addresses are stored in `downloads.json` in the root of the code repository (fields `windows` and `android`) and are built into the code at build time, like the banks address. The `VITE_DOWNLOAD_WINDOWS` and `VITE_DOWNLOAD_ANDROID` variables replace them for one build. The value `none` removes a link (in `downloads.json` an empty string works too), and without both links the block is not shown. An address that does not start with `https://` stops the build. The project's `downloads.json` points to its own repository; if you publish your own copy, replace the addresses, set them to `none` or delete the file.

By default the addresses point to the files of the latest release of the code repository:

```
https://github.com/<user>/<code-repo>/releases/latest/download/exam-trainer-windows-setup.exe
https://github.com/<user>/<code-repo>/releases/latest/download/exam-trainer-android.apk
```

Until such a release exists, the links return 404. How to publish a release is described in the "Making a release" section.

## Automatic app updates

Once a day, a few seconds after launch or when you return to the app, the Windows and Android apps read `latest.json` from the latest release of the code repository:

```
https://github.com/<user>/<code-repo>/releases/latest/download/latest.json
```

The address comes from `plugins.updater.endpoints` in `apps/desktop/src-tauri/tauri.conf.json` and is built in at build time, into the APK too. If `latest.json` has a version higher than the installed one, an "Update" button with the file size appears in the settings and under the subject list. Downloading starts only when you press it. The settings also have a "Check for updates" button. The web version does not need automatic updates: every visit opens the fresh build of the site.

Before installing, the app checks the downloaded file:

- Windows checks the installer signature with the public key from `plugins.updater.pubkey`, and the signed version must match the version in `latest.json`. Then the installer runs without prompts (a window shows the installation progress), the app closes and starts again as the new version.
- Android compares the size and SHA-256 with `latest.json`, then the package name, the APK version (it must match the version in `latest.json`), the build number (it must be higher than the installed one) and the APK signing certificate: it must match the certificate of the installed app. After that Android shows its own install dialog. The first time, it asks you to allow the app to install files.

The files in `latest.json` must be in the release `v<version>` of the same repository, and the apps do not download from any other address. A file that fails the check is deleted, and the app offers to download the new version by hand. Progress and settings are kept during the update.

Windows without a public key (an empty `pubkey`) does not look for updates and does not show the card. Android does not use the update key: it checks the authenticity of the APK by the signing certificate. So you need to keep both keys: the update key signs the Windows installer, and the APK key signs every new version for Android. Versions released before automatic updates appeared, and Windows installers built without a key, will not update themselves: install the new version in them by hand once.

### Update key

It is created once, from `apps/desktop`:

```bash
npx tauri signer generate -w ~/.tauri/exam-trainer.key
```

The command asks for a password and writes two files: the private key `exam-trainer.key` and the public key `exam-trainer.key.pub`. Put the string from `.pub` into `plugins.updater.pubkey` in `tauri.conf.json` and commit it. Keep the private key outside the repository (git does not see `*.key` files) and save a copy of it together with the password. If you lose it, apps with the old public key will not accept new versions.

## Signing the Windows installer (SignPath)

Without code signing, Windows SmartScreen meets the installer with an "Unknown publisher" warning. Open projects can be signed for free through [SignPath Foundation](https://signpath.org), but they only sign what GitHub Actions built from the project repository. So the release installer is built by the workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml). The APK key and the update key never reach GitHub: the APK and `latest.json` are still prepared on your computer.

The workflow starts on a `vX.Y.Z` tag or by hand (Actions, Windows installer, Run workflow). It takes the banks from the `exam-content` repository of the same owner (the repository must be public), checks the code and the banks, builds the app and sends `exam-desktop.exe` for signing. Then it packs the signed app into an installer and sends the installer for signing. You approve each of the two signatures in SignPath, and the workflow waits up to two hours for the approval. The finished installer is kept for 14 days in the `windows-installer-<version>` artifact on the run page. Until SignPath is set up, the workflow builds, checks and test-installs the same things, only without signing. A run stops if `plugins.updater.pubkey` is empty in that commit: such an installer would never update itself.

Setup, once:

1. Apply at [signpath.org](https://signpath.org). Their terms: an open license (GPL fits), no closed code, two-factor login on GitHub and in SignPath for all members, and the project already released in the form in which it will be signed. So the first release goes out unsigned. The "Code signing policy" section that SignPath requires is already in the README.
2. Go through the setup SignPath offers after approval (organization, project, signing policy, connecting GitHub Actions as the build source). The repository expects two artifact configurations in the project with the slugs `application` and `installer`: create them and paste into them the files from [`.signpath/artifact-configurations/`](../.signpath/artifact-configurations/).
3. In the GitHub repository (Settings, Secrets and variables, Actions) set the variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT` (the project slug) and `SIGNPATH_POLICY` (`release-signing`; for a trial with a test certificate, `test-signing`) and the secret `SIGNPATH_API_TOKEN`.
4. Add to the "Code signing policy" section of all three READMEs the line that SignPath requires: "Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)".

With the `release-signing` policy the workflow accepts only files with a valid SignPath Foundation signature (with `test-signing`, any signature: Windows does not trust the test certificate), and after signing it installs the installer into an empty folder and checks the signature of the installed app. The uninstaller that NSIS puts next to the app gets no separate signature.

## Making a release

1. Raise `version` in `apps/desktop/src-tauri/tauri.conf.json` (only the form `0.2.0`). The number in the installer name and the APK version come from it.
2. Build the signed APK (`npx tauri android build --apk --target aarch64`; signing is described in the README). Take the installer from GitHub Actions: push a tag (`git tag v0.2.0`, `git push origin v0.2.0`) or run the workflow by hand, approve both signatures in SignPath and download the `windows-installer-0.2.0` artifact. It is a zip archive with `exam-trainer-windows-setup.exe` inside. Without SignPath you can also build the installer yourself: `npx tauri build` in `apps/desktop`. The script from the next step refuses to run if the APK or the installer is of the old version.
3. Set the private update key and run `npm run release` from the repository root. `--windows` points to the installer from GitHub Actions; without this option the script takes the installer from the local build:

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/exam-trainer.key"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password>"
   npm run release -- --windows="$HOME/Downloads/exam-trainer-windows-setup.exe"
   ```

   In PowerShell the variables are set like this: `$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$HOME\.tauri\exam-trainer.key"`.

   The script puts the installer and the APK into `release/` (git ignores it) under the names `exam-trainer-windows-setup.exe` and `exam-trainer-android.apk`, signs both with the update key and writes `latest.json`. This signature is put on a file that SignPath has already signed, so SignPath comes first and `npm run release` second. The script refuses an installer of another version, the app itself instead of the installer, and an installer without a valid code signature. Until SignPath approves the project, add `--unsigned`: an unsigned installer then passes with a warning. `--notes="..."` adds a description to `latest.json`.
4. Publish the release with the command the script printed, or by hand on GitHub (Releases, Draft a new release) with the same three files:

   ```bash
   gh release create v0.2.0 release/exam-trainer-windows-setup.exe release/exam-trainer-android.apk release/latest.json --title v0.2.0 --notes "Code signing policy: https://github.com/<user>/<code-repo>/blob/main/README.en.md#code-signing-policy"
   ```

   SignPath requires the link to the code signing policy on every release page.

The tag must be exactly `v` plus the version from `tauri.conf.json`: `latest.json` links to the files of this tag. `latest` points to the most recent published release and skips drafts and pre-releases, so the apps see the new version only after it is published. A release always has both files: through `latest` the web version links to both the installer and the APK. The web version does not need a rebuild.
