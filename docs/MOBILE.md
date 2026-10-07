# Runway on Android

The mobile version is a dark web app that runs in Chrome on Android. It uses the same financial state format and interface as the desktop extension, with larger touch controls and quick purchase entry near the top.

## Open and install

Open your hosted Runway link in Chrome. For a private Sites deployment, sign in with the account that owns the Site when prompted; the login opens the application shell and does not synchronize financial records. Chrome's menu can offer **Add to Home screen** or **Install app**. The resulting shortcut/app opens Runway directly, without needing a ChatGPT conversation. Menu wording and install promotion depend on the browser. [Chrome's installation guide](https://web.dev/learn/pwa/installation) describes the supported flow.

Wait for the first online load to finish before going offline. The app registers its worker and caches only application assets. Once installed, it can open and save on this device offline. Reopen online periodically for code updates. Existing open tabs finish using their current shell; an updated worker becomes active after those tabs close.

## Records and backups

- Records belong to the current browser, device, and site origin. Using another browser or URL opens a separate plan.
- **Data & backups → Export backup** downloads all records as a JSON backup. Store it privately.
- **Restore backup** accepts that mobile backup or a desktop Runway `finance.json` file. You choose the file and confirm replacement. It is a whole-plan replacement, not a merge.
- No live desktop sync or bank sync is included. A restored desktop plan may contain imported cash-flow history; adding Monarch CSVs/account snapshots is currently a desktop operation.
- Clearing browser data can remove the records. **Keep browser storage** requests persistence when the browser supports it, but regular exported backups remain useful.
- Another tab's save is detected before replacing records. Reload the latest state if a conflict is shown.

Runway stores records locally in plain browser storage; it is not a password vault. It starts empty and never locates or uploads another installation's records.

## Build and host the shell

```sh
npm ci
npm run build:mobile
```

Publish only `dist/` to an HTTPS static host. The build copies a fixed list of application sources and generates launcher icons and a versioned offline worker. It never copies `finance.json`, imports, test profiles, or runtime screenshots. Paths are relative so the app can be served beneath a project subdirectory. Do not change the live origin casually: browser data remains bound to the old origin.

The public repository contains reusable source, not an individual's hosted Site identity or personal records. The hosting account controls access to the deployed shell. A private host must serve its manifest and worker assets after authentication; the manifest link includes credentials for this case.

## Verification

```sh
npm test
npm run build:mobile
npm run test:mobile
```

The mobile test runs on desktop Chromium with mobile viewport/touch emulation. It checks behavior and responsive layout; it does not claim testing on a physical Galaxy S23. Use Chrome on the phone for the final device check.
