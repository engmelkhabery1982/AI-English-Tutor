# AI English Tutor — Agent Repository Rules

This repository is an existing React Native + Expo + TypeScript application.

Google AI Studio / Antigravity is used ONLY as a coding execution agent.
It must NOT convert, adapt, migrate, or reconfigure this project for the
Google AI Studio web preview/full-stack runtime.

## PRIMARY RULE

Modify ONLY the files or directories explicitly listed in the current task
under ALLOWED FILES.

If the requested implementation requires modifying any other file:
STOP and report the blocker.
Do not make the extra change.

## PROTECTED FILES

Unless the current task explicitly names one of these exact files as allowed,
NEVER create, modify, delete, regenerate, or replace:

- package.json
- package-lock.json
- bun.lock
- yarn.lock
- pnpm-lock.yaml
- app.json
- app.config.js
- app.config.ts
- metadata.json
- tsconfig.json
- eslint.config.js
- eslint.config.mjs
- eslint.config.cjs
- babel.config.js
- metro.config.js
- eas.json
- .gitignore

## GOOGLE AI STUDIO RUNTIME CHANGES ARE FORBIDDEN

Do NOT add or configure anything merely to make Google AI Studio preview,
Build Mode, or its web runtime work.

In particular, do NOT add:

- react-dom
- react-native-web
- @expo/metro-runtime
- web-only build dependencies
- Google AI Studio metadata
- Bun configuration
- web preview scripts
- server-side Gemini integration
- Cloud Run configuration
- Build Mode compatibility changes

Do not change Expo scripts from the repository's existing configuration merely
for AI Studio preview.

If AI Studio itself creates or modifies such files in the workspace, those
changes are environment noise and MUST NOT be included in the task commit.

## GIT SAFETY

Never use:

git add .
git add -A
git commit -a

Stage ONLY the explicitly allowed task paths.

Example:

git add src/learner-model

Before committing, ALWAYS inspect:

git status --short
git diff --name-only
git diff --cached --name-only

Every staged file MUST be inside the task's ALLOWED FILES.

If any unrelated file appears:
restore or unstage it before committing.

## BRANCH SAFETY

Work only on the branch explicitly specified in the task.

Never:
- push to main unless explicitly instructed
- merge into main
- rebase shared history
- force push
- create unrelated branches
- merge unrelated branches

## SCOPE DISCIPLINE

One task = one bounded implementation.

Do not:
- refactor unrelated code
- upgrade dependencies
- modernize configuration
- fix unrelated warnings
- alter project architecture
- add convenience features not requested
- start the next roadmap task

## VALIDATION

Use the repository's existing validation commands exactly as instructed.

Do not alter dependencies or configuration merely to make validation pass.

Do not claim a command passed unless it was actually executed successfully.

## FINAL COMMIT CHECK

Immediately before commit:

1. Check branch.
2. Check changed files.
3. Check staged files.
4. Confirm every staged path is explicitly allowed.
5. Run required validation.
6. Commit only the requested task.
7. Push only the specified working branch.
8. Stop.

These repository rules persist across tasks.
A task may narrow these rules further but must not silently broaden them.
