# In-App Updater Setup (Tauri v2)

This app now includes a manual **Check for updates** button in the title bar.
To make updates actually work, configure Tauri updater and host update metadata + signed artifacts.

## 1. Configure `tauri.conf.json`

Update `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "active": true,
    "targets": "all",
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/Sciphr/chitchat/releases/latest/download/latest.json"
      ],
      "pubkey": "YOUR_MINISIGN_PUBLIC_KEY"
    }
  }
}
```

`pubkey` must match the private key used to sign update artifacts.

## 2. Generate Updater Signing Key (once)

```powershell
npm run tauri signer generate -w ~/.tauri/chitchat.key
```

Save the public key output into `plugins.updater.pubkey`.
Keep the private key secret.

## 3. Configure GitHub Secrets

In GitHub repo settings -> **Secrets and variables** -> **Actions**, add:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of your private key file (`chitchat.key`)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: key password (leave empty if no password)

## 4. Automated Release Flow (already wired)

`.github/workflows/release.yml` now:
- triggers on tags matching `v*`
- builds and publishes via `tauri-apps/tauri-action`
- uploads updater artifacts (including `latest.json`) to the GitHub release

Create a release tag:

```powershell
git tag v0.1.1
git push origin v0.1.1
```

After workflow completes, updater metadata is available at:
- `https://github.com/Sciphr/chitchat/releases/latest/download/latest.json`

## 5. Manual Build (optional)

```powershell
npm run tauri build
```

With `createUpdaterArtifacts: true`, Tauri generates updater files in:
- `src-tauri/target/release/bundle/`

## 6. If You Host Updates Yourself (optional)

Host files on static storage or web server (Cloudflare R2/S3 + CDN, Nginx, GitHub Release assets, etc).

`latest.json` example:

```json
{
  "version": "0.1.1",
  "notes": "Bug fixes and UI improvements.",
  "pub_date": "2026-02-12T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "MINISIGN_SIGNATURE_FROM_ARTIFACT.sig",
      "url": "https://updates.yourdomain.com/chitchat/0.1.1/ChitChat_0.1.1_x64-setup.nsis.zip"
    }
  }
}
```

## 7. Runtime behavior

- User clicks **Check for updates** in Settings.
- App checks `latest.json`.
- If newer version exists, it downloads and installs.
- App prompts user via status text to restart and complete update.
