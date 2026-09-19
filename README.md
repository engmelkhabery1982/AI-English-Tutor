# AI English Tutor

A personal, offline-first English tutor for Android. It combines conversation,
adaptive lessons, listening, review, pronunciation and a deterministic local
daily-tutor loop on top of a local SQLite learner model.

> **Status: development / release-candidate foundation — NOT production ready.**
> This repository now builds reproducibly with a real Android identity and
> release profiles, but it ships no runtime secret storage and defaults to demo
> providers when no API key is present. See
> [Environment variables](#environment-variables) and [Known limitations](#known-limitations).

---

## Prerequisites

- **Node.js 20+** (LTS) and **npm** (the repository is locked with
  `package-lock.json`; use npm, not yarn/pnpm/bun).
- **Android tooling** for local native validation:
  - Android Studio + Android SDK (platform tools, build tools, an emulator or a
    physical device with USB debugging).
  - A JDK compatible with the React Native version in `package.json`.
- **Expo CLI** — use `npx expo ...`; no global install is required.
- **EAS CLI** (`npx eas-cli@latest ...`) only if you want cloud builds. Building
  with EAS requires an Expo account; see [EAS build profiles](#eas-build-profiles).

## Install

```bash
npm install
```

## Run (dev server)

```bash
npm start                    # Expo dev server (Metro)
npm run android              # start and open on a connected Android device/emulator
npm run ios                  # start and open on iOS (macOS only)
npm run web                  # start the web target
npx expo start --dev-client  # run against a `development` profile build (see below)
```

## Quality gates

Run all three before committing. They must be clean.

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src
npm test           # vitest run
```

Run a single test file, repeatedly if you are chasing a flake:

```bash
npx vitest run src/data/local/sqlite/repositories.test.ts
```

## Expo / dependency health

```bash
npx expo install --check     # are installed versions SDK-compatible?
npx expo-doctor@latest       # full project health report
npx expo install --fix       # align package versions with the installed SDK
```

`npx expo config --type public` prints the resolved public app config, and
`npx expo config --type prebuild` shows what native generation will produce
(android package id, permissions, splash/icon resources).

## Android identity and local native validation

| Field | Value |
| --- | --- |
| `expo.name` | `AI English Tutor` |
| `expo.slug` | `ai-english-tutor` |
| `expo.version` (Android `versionName`) | `1.0.0` |
| `expo.android.package` | `com.melkhabery.aienglishtutor` |
| `expo.android.versionCode` | `1` |

Verify the resolved identity before building:

```bash
npx expo config --type public  | grep -i package
npx expo config --type prebuild | grep -i -E "package|versionCode"
```

Generate the native Android project locally (this writes `android/`, which is
**gitignored** — never commit it) and build a debug artifact:

```bash
npx expo prebuild --platform android
npx expo run:android            # builds and installs a debug build
```

For a signed release you must supply your own keystore. **Do not commit
keystores or signing credentials** — `*.jks`, `*.keystore`, `*.p12`, `*.key` and
`*.mobileprovision` are gitignored, and no credential is present in this
repository.

## EAS build profiles

`eas.json` defines three Android profiles:

| Profile | Purpose | Output |
| --- | --- | --- |
| `development` | Development client build for debugging (uses the installed `expo-dev-client`) | APK, internal distribution |
| `preview` | Internal QA build of the real app | APK, internal distribution |
| `production` | Release build | AAB (app bundle) |

```bash
npx eas-cli@latest build --platform android --profile preview
npx eas-cli@latest build --platform android --profile production
```

`cli.appVersionSource` is `local`, so the version and `versionCode` come from
`app.json` and stay reviewable in git. Cloud builds require an authenticated
Expo account and a project ID; **no project ID, keystore, or credential is
committed here** — configure those yourself with `npx eas-cli@latest init`.

## Environment variables

Variable **names** are documented in [`.env.example`](./.env.example). Copy it
to `.env` (or `.env.local`) and fill in values locally:

```bash
cp .env.example .env
```

| Name | Purpose |
| --- | --- |
| `EXPO_PUBLIC_GEMINI_API_KEY` | Gemini API key used by the AI and speech-to-text providers in development |
| `EXPO_PUBLIC_GEMINI_API_BASE_URL` | Optional Gemini REST endpoint override |

`.env` and every `.env.*` file are gitignored; only `.env.example` (names, no
values) is tracked. **No real key belongs in this repository.**

### ⚠️ `EXPO_PUBLIC_*` is NOT appropriate for production secrets

Expo **inlines** every `EXPO_PUBLIC_*` variable into the compiled JavaScript
bundle in plain text. Anyone who installs the app can extract it. That makes
`EXPO_PUBLIC_GEMINI_API_KEY` a **development/demo convenience only**. Runtime
secret storage (device keystore / secure storage) is **not implemented in this
package** and is tracked as separate follow-up work. Do not ship a production
key through `EXPO_PUBLIC_*`.

## Development / demo behavior

- With **no** `EXPO_PUBLIC_GEMINI_API_KEY` set (the default for a clean
  checkout), the app runs against its built-in **demo** AI and speech-to-text
  providers. This is a developer/demo mode, not a production configuration.
- The learner model, review scheduling, listening, adaptive lessons and the
  daily tutor loop are deterministic and run locally against SQLite; they do not
  require network access.
- No scores, percentages or invented metrics are produced for the learner.

## Known limitations

This repository is a **release-candidate foundation**, not a shippable product:

- No runtime API-key entry or secure secret storage (see above).
- No in-app settings surface for providers.
- Production release signing is not configured (intentional — no credentials in
  git).
- iOS has no configured bundle identifier yet; this package scopes Android.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/domain` | Domain models and shared types |
| `src/learning-progression`, `src/curriculum` | Level/difficulty guidance and the skill map |
| `src/review`, `src/listening`, `src/adaptive-lessons`, `src/deep-speaking` | Learning engines (each owns its own domain) |
| `src/content-generation` | Shared AI content request/validation contract |
| `src/data/local/sqlite` | SQLite schema and repositories |
| `src/daily-tutor` | Deterministic local daily orchestrator |
| `src/screens` | React Native screens (mobile-first) |
| `src/providers` | Vendor-neutral AI / STT / TTS provider interfaces |
