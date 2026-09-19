# Wave 3 — learner-facing product / UX report

Date: 2026-09-19 (UTC).

**Delivery status:** implementation and local regression gates passed. External Expo validation is blocked by network/TLS failures. Android device/emulator validation was not performed. This is not a release approval.

## 1. Delivery branch and SHA

Work was performed only on `arena/01a0b7dc-ai-english-tutor`, the branch fixed to this Arena session. The requested `arena/wave3-ux-product-polish` branch was not checked out, modified, or pushed. This constraint was disclosed before work began. No additional branch was created. The final commit SHA and push confirmation are supplied in the delivery response; this report is included in that commit.

Commit message: `feat(ux): complete learner-facing product experience`.

## 2. Starting baseline

`git fetch origin` completed before code changes. The working tree was initially clean and HEAD was exactly:

`f747fc8a8a1fe20d158079021ae783ee16adf509`

Dependencies were installed using the existing lockfile (`npm ci`). Neither package manifest nor lockfile was changed.

## 3. Was the integrated baseline green before UX changes?

**Code gates: yes. All five requested gates: no — two external checks were blocked.**

| Baseline command | Result before UX edits |
| --- | --- |
| `npm test` | 70 files, 1,956 tests passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; 0 errors, 228 existing warnings |
| `npx expo-doctor@latest` | 19/21; Expo API schema fetch/TLS failure and React Native Directory server-response failure |
| `npx expo install --check` | Blocked by TLS connection failure |

The remote-check failures were disclosed before implementation; they were not treated as successful checks or repaired by suppressing validation.

## 4. Wave 2 integration repair

None. No failing integrated test or type error was found. No separate integration-repair commit was needed.

The UX audit did uncover existing **presentation** problems: reassessment used a placeholder learner ID for its status lookup; failed status reads could appear ready/empty; several composition retries did nothing; Review advertised five cards for a zero-due queue; Demo labels/counts needed clearer separation. These were fixed in the screens, not by changing evidence algorithms or persistence.

Preserved without edits: SQLite schemas/migrations and ownership, persistence/idempotency algorithms, Review identity/evaluation, recorder/coordinator internals, voice lifecycle modules, provider credential precedence, SecureStore, pronunciation scoring/evidence, and Android release configuration. The only non-screen production service change is a bounded, read-only `loadStrengths` presentation accessor on the existing Progress dashboard service. It uses the repository already supplied by the unchanged composition.

## 5. Exact files changed

- `docs/wave3-ux-report.md`
- `src/adaptive-lessons/index.test.ts`
- `src/daily-tutor/navigation.test.ts`
- `src/deep-speaking/index.test.ts`
- `src/navigation/RootNavigator.tsx`
- `src/navigation/learner-journey.ts`
- `src/navigation/routes.test.ts`
- `src/navigation/routes.ts`
- `src/onboarding/index.test.ts`
- `src/professional-english/integration.test.ts`
- `src/progress-dashboard/index.test.ts`
- `src/progress-dashboard/service.ts`
- `src/screens/AdaptiveLessonScreen.tsx`
- `src/screens/DailyTutorScreen.tsx`
- `src/screens/DeepSpeakingScreen.tsx`
- `src/screens/FluencyPracticeScreen.tsx`
- `src/screens/HomeScreen.tsx`
- `src/screens/ListeningScreen.tsx`
- `src/screens/OnboardingScreen.tsx`
- `src/screens/ProfessionalEnglishScreen.tsx`
- `src/screens/ProgressScreen.tsx`
- `src/screens/ReassessmentScreen.tsx`
- `src/screens/ReviewScreen.tsx`
- `src/screens/SettingsScreen.tsx`
- `src/screens/SpeechPracticeScreen.tsx`
- `src/screens/TalkScreen.tsx`
- `src/screens/VocabularyScreen.tsx`
- `src/screens/components/LearnerButton.test.tsx`
- `src/screens/components/LearnerButton.tsx`
- `src/screens/components/MicrophoneHelp.tsx`
- `src/screens/components/ProviderSettingsLink.tsx`
- `src/screens/components/SavedItemAudio.tsx`
- `src/screens/listening/DeepListeningPanel.tsx`
- `src/screens/product-ux.test.ts`

Generated Android bundles and validation logs are outside the repository, under `/home/user/ux-validation`; they are not committed.

## 6. Navigation / reachability

| Capability | Learner-facing entrance | Existing implementation |
| --- | --- | --- |
| Home | Home bottom tab | HomeScreen |
| Daily Tutor | Home primary action | DailyTutorScreen |
| Talk | Home secondary action / Talk tab | TalkScreen |
| Review | Home secondary action / Review tab | ReviewScreen |
| Listening | Home → Choose a skill | ListeningScreen |
| Pronunciation | Home skill link; Listening link | Thin stack entrance → ListeningScreen → existing repeat/compare panel |
| Shadowing | Home skill link; Listening link | Thin stack entrance → same repeat/compare panel |
| Fluency | Home skill link; speaking-coach handoff retained | FluencyPracticeScreen |
| Vocabulary | Home → Saved words & expressions | VocabularyScreen |
| Progress | Progress bottom tab | ProgressScreen |
| Reassessment | Progress and Settings | ReassessmentScreen → existing assessment workflow |
| Settings | Settings bottom tab; provider recovery links | SettingsScreen |

The seven original tab routes remain registered, preserving nested Daily Tutor routing. Listening and Vocabulary are hidden from the crowded bottom bar but have direct, described Home entrances. Five visible tabs remain: Home, Talk, Review, Progress, Settings. Specialist root-stack entrances have native back navigation and an explicit return action. No second pronunciation/shadowing engine or copied exercise screen was introduced.

## 7. Reassessment entry

“Check my English level again” is available in Progress and Settings. Copy explains reassessing after practice and explicit acceptance of a suggested level, not continuous automatic level changes. The screen resolves the actual profile ID through the existing onboarding service. No profile leads to initial assessment; failed history reads show retry, not fabricated readiness. Assessment persistence and the existing workflow are unchanged.

## 8. Pronunciation, shadowing and fluency

- **Talk:** open conversation, spoken or typed.
- **Pronunciation:** repeat known target language and compare the recognized spoken words. Copy explicitly says the existing processor provides transcript/word-level feedback, not acoustic or phoneme scoring or generic AI opinion.
- **Shadowing:** listen, imitate, compare. It uses the same supported repeat-and-compare path, filtered through the existing `taskTypes: ['shadowing']` planner option.
- **Fluency:** repeat speaking tasks with progressively less support; no invented fluency percentage.

Unavailable capture disables the record action. Processing, permission guidance, recording and playback have explicit labels. Playback/next actions are disabled during conflicting speech work. Existing service/controller guards remain authoritative.

## 9. Home hierarchy

Daily Tutor is the only filled primary CTA. Talk and Review follow as secondary actions. Specialist practices are lower-weight, described rows rather than identical competing cards. Adaptive lessons remain reachable below the skill list with a secondary CTA. Loading, stale-plan and retry messages are explicit.

## 10. Settings

Organized into AI provider/status, masked key configuration, explicit Demo explanation, learning/assessment, and About/privacy. Initial assessment and reassessment are distinct actions. Status text, diagnostics and recovery remain visible; exceptions do not expose raw errors. Privacy copy distinguishes a locally stored key from its use to authenticate provider requests. No stored secret is rendered. No database-reset action was added.

## 11. Vocabulary and audio

Existing words/phrases/expression categories, all saved meanings, examples, review buckets and Review practice entry remain intact. The details modal offers “Hear pronunciation” / “Stop audio” using the existing Expo TTS provider and TTS controller. It uses existing background/focus/unmount cleanup facilities. The component imports no workspace, evidence, review or repository writer. It explicitly labels replay as listening only, not learner practice. No definitions or examples were generated.

## 12. Strengths and areas to practise

Progress displays up to 20 actual persisted strength records: qualitative type, saved notes/context and last-observed date. Empty and failed reads are distinguished. No confidence number becomes a score. Existing weakness lifecycle data is presented as “Areas being trained”; recent activity/progress remain the existing read-only records.

## 13. Accessibility

- Shared lightweight native button wrapper: button role, native disabled state, accessibility disabled/busy/selected metadata preservation, default 48dp minimum targets, disabled appearance.
- Explicit accessible names on every screen TextInput.
- Accessible labels/hints on critical recording/playback/provider/navigation controls.
- Selected assessment chips expose selected state rather than relying only on color.
- Provider and important loading/error/voice states have text and appropriate live-region/alert metadata.
- Several 10–11pt secondary labels were raised to 12pt.

These are source/native-prop contracts, not a claim of completed TalkBack validation.

## 14. Mobile / safe-area work

The stack uses safe left/right insets and a bottom inset for pushed screens; navigation headers retain responsibility for the top inset and the tab bar retains its bottom inset. Vocabulary and Talk modals use SafeAreaView. Crowded headers/control rows wrap; the bottom bar has five visible items. Scrolling forms keep taps available with the keyboard and use automatic keyboard insets where supported. Review completion is scrollable; Talk retains its KeyboardAvoidingView. No large fixed-width content blocker is present in the tested screen source. Android keyboard/inset/font-scale behavior still requires device validation.

## 15. Dead, placeholder and misleading UX removed

- No-op retry paths now retry composition in Vocabulary, Progress, Listening and speaking practice; Fluency has a retry.
- Review storage errors no longer look like an empty queue, and it refreshes after returning from profile setup.
- Review no longer substitutes “5 items” into a zero-due CTA or calls Demo results personalized learner cards.
- Demo mode is explicitly labelled through Review dashboard, active answer/feedback and completion states, and can be left from its dashboard. Cached sample counts are cleared when returning to a real no-profile state.
- Reassessment no longer uses `default-learner` or manufactures availability after a thrown read error.
- Raw thrown exception text in speaking/fluency/Talk presentation is replaced with recovery-oriented copy.
- “Diagnostic” was changed to “assessment” in the edited learner-facing assessment copy; technical identifiers remain unchanged.
- Source/AST contracts verify buttons have handlers, known navigation destinations exist, and no “Coming soon”/empty-handler Settings placeholder remains.

## 16. Targeted regression tests

**52 files / 1,444 tests passed.** Command:

```sh
npx vitest run src/navigation src/screens src/daily-tutor src/adaptive-lessons \
  src/talk-demo src/review src/listening src/pronunciation src/deep-speaking \
  src/fluency src/vocabulary-workspace src/progress-dashboard src/reassessment \
  src/onboarding src/provider-config src/data/local/sqlite src/voice
```

Coverage includes the requested Home/navigation/Daily Tutor/Talk/Review/Listening/Pronunciation/Shadowing/Fluency/Vocabulary/Progress/Reassessment/Settings contracts plus provider configuration, database composition and voice lifecycle regression suites.

Thirty tests were added: 24 product source/AST contracts, 3 native-button prop contracts and 3 real-SQLite strength-read tests. Existing navigation/copy assertions were updated to the actual rendered registry and “assessment” terminology; evidence assertions and lifecycle tests were not removed or weakened. Source tests are explicitly not native rendering tests.

## 17. Full Vitest

`npm test`: **72 files / 1,986 tests passed**. Baseline: 1,956. No skipped or weakened failing engine test.

## 18. Typecheck

`npm run typecheck`: **passed**.

## 19. ESLint

`npm run lint`: **passed, 0 errors / 228 warnings**, same warning count as the baseline. Existing warnings were not suppressed.

## 20. Expo Doctor

`npx expo-doctor@latest`: **19/21, blocked**, both before and after changes. Unresolved checks:

1. Expo config schema check: `TypeError: fetch failed`, TLS connection disconnected before establishment.
2. React Native Directory metadata check: unexpected server response.

These need an online rerun in the release-validation environment. No Doctor exclusion was added.

## 21. Expo install check and Android bundle

- `npx expo install --check`: **blocked by TLS failure**, both baseline and final run.
- Supplementary `EXPO_OFFLINE=1 npx expo install --check`: reports **Dependencies are up to date**, with Expo's warning that offline dependency validation is unreliable. This is not a substitute for the required online gate.
- `npx expo export --platform android --output-dir /home/user/ux-validation/android-export`: **passed**, producing a production Android Hermes bundle. This is compilation/export only, not an APK install or runtime test.
- `git diff --check`: passed.
- `npm ci` reported 14 moderate audit vulnerabilities in the existing locked dependency tree. No dependency changes or force-upgrades were made; dependency/security triage belongs in release validation.

## 22. Deferred to final Android release validation

No physical Android device or emulator was used. Validate all of the following before release:

1. Install/launch the real signed Android build; cold start, resume and persisted-data reopen.
2. Small widths (including 320/360dp), large system fonts/display scale, landscape, gesture and three-button navigation; no clipping/overlap; safe areas in stack/tab screens and both modals.
3. Keyboard visibility and scrolling for Talk, provider key input, Review, assessment/reassessment, Fluency and vocabulary edits.
4. TalkBack focus order, labels, selected/disabled/busy announcements and actual touch targets; contrast and readable status text.
5. End-to-end navigation through every route in the table, native back, system back, profile setup return, Daily Tutor child completion return and specialist exits.
6. Microphone allow/deny/permanent-denial flows and return from device settings; real STT, no invented transcript/evidence, processing disables conflicting actions.
7. Real speaker/headset/Bluetooth routing; microphone/TTS interruption and replay; incoming calls, lock screen, background/foreground, rapid exit/re-entry, rapid taps and slow provider callbacks.
8. Saved-item TTS stop/replay, modal close, tab change and background; confirm no review/practice/evidence counters change solely from playback.
9. Android SecureStore/Keystore save/replace/remove/restart behavior; masked keys; configured/unconfigured/rejected/offline/service-outage diagnostics using real provider requests.
10. Demo banners on dashboard/answer/feedback/completion; leaving Demo; verify no Demo learning evidence persists.
11. Reassessment using the real profile/history, explicit accept/keep-level paths, retained evidence, and storage/network recovery; pronunciation feedback limitations and actual audio quality.
12. Rerun both blocked online Expo checks and review the existing npm audit findings. Keep DB recovery/reset mechanics out of accidental learner UI.

## 23. Main / merge protection

`main` was not checked out, committed to, pushed or merged. Local `main` and fetched `origin/main` remained at `f747fc8a8a1fe20d158079021ae783ee16adf509` during final checks. Only the fixed Arena session branch is to be pushed. No merge and no pull request was performed.
