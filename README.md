# Runway

A local financial planning and debt freedom tool: checking and cash buffer, bills, spending caps, debt balances, and imported cash-flow history. Start from an empty plan and supply your own numbers.

Runway is an independent optional extension for Electron hosts such as ARCHi. It includes a reusable backend, a financial interface, an Electron host adapter, and a standalone launcher. This repository does not modify or require a fork of ARCHi. ARCHi currently has no automatic extension loader: using the adapter inside a host requires the small integration described in [docs/ARCHI-INTEGRATION.md](docs/ARCHI-INTEGRATION.md). Downloading this repository alone does not install a button in an existing ARCHi application.

## Run locally

Install Node.js 24, then:

```sh
git clone https://github.com/2dels/Runway.git
cd Runway
npm ci
npm start
```

If Electron's binary was skipped during dependency installation, run `npm run setup` once. Dependency installation downloads development/runtime packages; the running application uses no cloud service or bank connection. Windows is the tested desktop target. No installer, Android client, voice interface, or sync service is included in this first release.

## Set up an empty plan

Use the plan/settings controls to enter your checking balance, its date, cash buffer, pay schedule, rent, spending caps, and debt goal. Add bills, cards, and other debt as needed. Nothing is preloaded from an ARCHi installation or from a financial account.

- **Spending:** record a purchase, category, and note; review it against monthly caps. Manual purchases track spending caps only; they do not automatically change checking or enter imported cash-flow history. Avoid recording the same purchase manually and through an import.
- **Bills and cash planning:** record upcoming bills, mark payments, and model your configured paycheck and rent schedule. Balances are estimates based on your inputs, not a bank feed.
- **Debt:** add card balances and rates, other debt, payment deadlines, and a target date. Estimates use entered data and do not include unrecorded fees or purchases.
- **Imports:** select a Monarch transaction or account-balance CSV, or a JSON account/recurring snapshot from your device. Imported source IDs deduplicate repeat exports; they do not reconcile independent manual entries. Review the import report and account dates. No Monarch login is needed or stored.

## Your data

The standalone launcher uses `~/.runway` (`%USERPROFILE%\.runway` on Windows). Financial records live in `finance.json`; a previous-save backup is kept separately as `finance.backup.json`. These files are plain local JSON, not encrypted. A host using the adapter must explicitly choose its own private data directory outside the source checkout. There is no automatic discovery, migration, upload, telemetry, or access to an existing ARCHi profile.

This Git repository contains application code, empty defaults, and explicitly synthetic test inputs. Financial records, exports, screenshots, runtime files, and local environment files are excluded. Do not commit your own records when customizing it. See [PRIVACY.md](PRIVACY.md) for the release boundary.

## Backend and integration

```js
import { createFinanceStore } from '@2dels/runway';

const finance = await createFinanceStore('/absolute/private/runway-data');
const { state, loadError } = finance.snapshot();
// Edit a copy of state, then await finance.save(state).
// Always surface loadError; a failed read must not become an empty replacement.
await finance.flush();
```

The backend validates records, serializes local writes, writes atomically, and refuses overwriting corrupt files or files changed outside the store. This is a single-device store, not a multi-user sync API. The Electron adapter uses a sandboxed window, an isolated session, a limited preload bridge, a local asset allowlist, and native file pickers. See the [host example](examples/archi-host.mjs).

## Verify

```sh
npm test
npm run check:release
npm run smoke
```

Unit tests use synthetic data and temporary directories. The Electron smoke uses a disposable `.runtime` profile, exercises the actual interface, restarts the app, and checks isolation. Run it in a desktop session. CI runs the backend and release checks; the desktop smoke is a separate local check.

Code is MIT licensed, with upstream attribution retained. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No private artwork or financial exports are bundled.
