# Work Order 3 — functional learning contracts / Bolt handoff

Baseline: `8197b7213e91f021bf450fe355bf217c12e4d24d`.
Branch: `arena/01a0bfa7-ai-english-tutor`.

## Reachable workflows

- **Home → Learning tools**: paste original text; select an item/type; supply context and translation language; inspect meaning, common senses, usage/register, translation, rephrase and alternatives. Save a selected meaning to existing Review.
- **Learning tools → Listening / Reading**: choose content difficulty (not a learner-level change), load one of six authored starters or generate a short lesson on a topic. Reading and listening use the same story model and comprehension evaluator. Answer all questions, then explicitly complete.
- **Listening**: device TTS, replay, stop, slower playback when supported, transcript reveal/hide, contextual language reveal and inspection. Playback must really start before a listening answer is accepted.
- **Reading → Read aloud**: record, stop/transcribe, inspect recognized text, explicitly compare, retry. Comparison uses the existing pronunciation transcript-comparison provider, not acoustic analysis.
- **Review → Start review**: deterministic initial mode; choose another supported mode from the same card. Modes include item production, meaning recall, context gap, meaning choice when distinct stored meanings exist, own sentence, listening recognition, and spoken own-sentence production. Semantic evaluation requires a configured provider. A failed evaluation creates no result. New-context generation is an explicit action, never a new review row.
- **Learning tools → Recommended next activity**: up to three explanations and working launch actions. Refresh after practice to read updated evidence.

No Talk business logic was added. Existing tab order, theme and major screens remain intact. A single pushed route and a Home link provide entry points; new panels are intentionally plain.

## Domain/service ownership

| Public contract | Responsibility |
| --- | --- |
| `dictionary/inspector`: `InspectionInput`, `LanguageInspection`, `InspectedMeaning`, `createLanguageInspector`, `inspectionSaveInput` | ONE new contextual dictionary/translate/rephrase front door. Existing legacy dictionary and document-translation APIs remain compatible; new UI never composes separate engines. `sourceRef` is ready for future importers. No document ingestion built. |
| `dictionary/inspector-controller`: `InspectorState`, `InspectorController` | Exact input retention, single-flight loading, explicit retry, edit/blur/dispose invalidation. Accepts a provider resolver so fixing Settings need not erase the draft. |
| `providers/structured-generation`: `GenerationResult<T>`, `generateStructured` | Provider-neutral structured requests; central WO1 classification; at most one transient automatic retry before commit; no demo fallback; runtime validation; late result rejection. |
| `lessons/types`: `StoryLesson`, `LessonQuestion`, `LessonLanguage`, `LessonSessionSnapshot` | Shared reading/listening content, content-level intent, provenance, interaction state. |
| `lessons/catalogue`, `lessons/generation`: `starterForLevel`, `LessonRequest`, `generateStoryLesson` | Six authored A1–C2 starters or honest provider generation. Generated questions/options, source contexts and item types are structurally validated. |
| `lessons/session`: `StoryLessonSession` | Shared session lifecycle, TTS ownership, real-answer comprehension, sticky assistance markers, retry-safe completion, inspector/save adapters. Delegates evaluation to the existing listening evaluator. |
| `lessons/read-aloud`: `ReadAloudPractice`, `ReadAloudFeedback` | Existing Review voice lifecycle controller + existing pronunciation baseline. Explicit comparison, real STT text, omission/substitution feedback, no acoustic or CEFR score. |
| `lessons/activity`: `PracticeActivity`, `recordPracticeActivity`, `readPracticeActivity` | Typed interaction metadata in existing progress rows, not a new analytics store. |
| `review/active-modes`: `ActiveReviewMode`, `ActiveReviewSpec`, `ActiveReviewEvidence`, `ReviewCapabilities`, `activeReviewCandidate`, `evaluateActiveReview` | Deterministic capabilities/context/sense-aware exercise projections, provider semantic feedback, no new scheduler. |
| `review/context-practice`: `varyReviewContext` | New examples constrained to the selected stored sense, avoids recent duplicate examples, marks AI provenance, preserves lexical/review identities. |
| `ReviewService.changeMode`, `.varyContext`, existing `.recordPracticeResult` | Existing Review orchestration and persistence for every new mode. |
| `adaptive-lessons/next-focus`: `NextFocusInput`, `NextFocusSummary`, `NextPracticeRecommendation`, `buildNextFocusSummary` | Read-only next-activity projection of the EXISTING adaptive planner, with reading/listening/speaking evidence coverage and recency balancing. |
| `progress-dashboard/next-focus-service`: `NextFocusService.load` | Reads existing SQLite repositories and adaptive service; provides deduplicated Home/Progress data without mutating records. |
| `lessons/composition`: `LearningTools`, `createLearningTools` | Real production composition on canonical app database and configured providers. |

## Evidence and persistence rules Bolt must retain

1. Saving means **“I want to review this”**, not learned/mastered. It uses the WO2 service only. Same normalized learner/text/type = existing row, unchanged meaning/schedule. Saving a second inspector sense of the same item **does not overwrite/append** the first sense; this intentionally preserves WO2 duplicate policy. Existing lexical records containing several meanings can practise them independently.
2. Saved provenance now includes original text, selected sense and provider ID in existing `source` JSON. Examples distinguish generated, curated and manual source text. Generated meanings remain review notes, not authoritative dictionary entries.
3. Active review rotates stored meanings/examples. If only one example exists, later attempts omit it instead of endlessly redisplaying it; learner can explicitly request a provider-generated new context. Meaning choices require genuine distinct stored meanings. Meaning recall and own-sentence semantics require provider capability. `ActiveReviewEvidence` carries controller-observed STT/playback facts; the service refuses speaking/listening evaluation and persistence without the appropriate evidence. Sentence item types do not get “create a sentence using this sentence” tasks.
4. Only the selected meaning's review schedule is updated. Review identities, attempt identity/idempotency and existing review history remain the persistence owner. Generated contexts recorded in review history are labelled as generated.
5. Story assistance (transcript, contextual language, feedback, replay, slower playback) is distinct from answers. Exposure records have **zero** completed turns and sessions. Actual non-empty valid choices create comprehension records. All questions answered + explicit Complete produces one session-completion event. No duration-based score, no skipped-question grade, no automatic proficiency/level changes.
6. `ProgressRepository.record(record, eventKey?)` is backward-compatible. A supplied key is hashed with the learner ID to an existing progress-row ID; `ON CONFLICT(id) DO NOTHING` gives restart-safe idempotency. No table, migration, row reset or deletion was introduced. A failed answer save retains a pending choice; an uncertain commit cannot be retried with a different answer under the same key.
7. Read-aloud evidence is explicitly **transcript comparison**. STT can misrecognize speech. Target matches do not prove good pronunciation. Feedback never invents percentages, phonemes or improvement. Real audio/STT and explicit Compare are required.
8. Next-focus summaries deduplicate references and evidence. Recent improvement is narrowly worded: a recorded correct review after an earlier miss/partial response, not a general skill improvement. Legacy untyped activity remains unknown; typed exposure is not a proficiency score. Exact due queue count is independent of bounded recent-history reads.
9. Do not render `failure.technical` or raw provider responses. Failure messages use the WO1 catalog; configuration/blocked/quota failures are not automatically replayed. Input/topic/current lesson survive provider failures. Explicit retry is offered where policy permits.
10. Keep `dispose`/`cancel`/`stop` and focus/background guards when replacing screens. Provider completions and STT callbacks must not resurrect abandoned work. TTS and recording must not overlap on a surface.

## Screens Bolt may redesign

- `LearningToolsScreen`, `learning/InspectorPanel`, `learning/StoryPanel`: replace presentation while calling the above contracts.
- `ReviewScreen`: replace card/controls, retaining ReviewService, attempt IDs, audio/voice gates and lifecycle guards.
- `HomeScreen` and `ProgressScreen`: may consume `NextFocusService.load()`; do not reimplement planning, infer skill scores or migrate records to remove visual repetition.
- Existing Talk, Listening, SpeechPractice, Vocabulary, Settings and adaptive screens remain governed by their existing services and WO1/WO2 contracts. This order does not authorize changing those business rules.

## Validation boundary

Automated coverage includes inspector types/context/translation/rephrase/provenance/errors/retry/input preservation; shared lessons and assistance semantics; actual read-aloud recording/STT/mismatch/failure/lifecycle; active modes/variety; real SQLite save/review/progress idempotency; adaptive evidence/reasons/recency/deduplication; and functional entry-point wiring. See final delivery for exact commands and final counts.

Android JavaScript/Hermes export and native prebuild succeeded. Native install/runtime validation is **blocked** in this sandbox: Android SDK path is absent and `adb` cannot be spawned (`ENOENT`). No microphone, device TTS, or live Gemini end-to-end test on an Android device is claimed. A configured-device smoke test remains necessary before release. Generated native directories and bundles are ignored, not committed; prebuild's automatic package-script changes were reverted.

### Final validation commands and results

- `npx vitest run src/dictionary/inspector.test.ts src/lessons src/review/active-modes.test.ts src/adaptive-lessons/next-focus.test.ts src/screens/learning-entrypoints.test.ts src/providers/failures.test.ts` — PASS, 8 files / 107 tests (includes existing provider-classifier tests).
- `npm test` — PASS, 94 files / 2,289 tests. This order adds 78 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — exit 0; 0 errors, 245 warnings. No claim of a warning-free lint run.
- `npx expo export --platform android` — PASS; Android Hermes bundle exported (1,220 modules).
- `npx expo config --type public | grep -i package` — PASS; expected Android package.
- `npx expo config --type prebuild | grep -i -E 'package|versionCode'` — PASS; expected package and versionCode 1.
- `npx expo prebuild --platform android` — PASS; ignored native project generated. Expo warns that expo-system-ui is not installed for userInterfaceStyle.
- `CI=1 npx expo run:android --no-bundler` — BLOCKED / exit 1; missing Android SDK and `spawn adb ENOENT`. The flag prevents launching a long-lived bundler during validation; it does not bypass the native build/install check.
- `git diff --check` — PASS.

The native gate is not reported as passed. No production runtime/device or live-provider end-to-end pass is claimed.
