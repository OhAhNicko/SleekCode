---
name: release
description: Bump version, commit, tag, and push to trigger a CI release build
argument-hint: "[version]"
---

Bump the app version and trigger a CI release build.

1. Read current version from `package.json` (`"version"` field).
2. Determine target version:
   - If `$ARGUMENTS` is a valid semver (e.g. `0.2.0`): use it.
   - If `$ARGUMENTS` is empty or missing: auto-increment the patch version (e.g. `0.1.2` → `0.1.3`).
   - If `$ARGUMENTS` is invalid: STOP and ask.
3. Bump version in ALL THREE files (all must match):
   - `package.json` → `"version": "<version>"`
   - `src-tauri/Cargo.toml` → `version = "<version>"`
   - `src-tauri/tauri.conf.json` → `"version": "<version>"`
4. Run `npm run typecheck` — if it fails, STOP and report errors.
5. `git add -A && git commit -m "chore: bump version to <version>"`
6. `git push`
7. `git tag v<version> && git push --tags`
8. Report: "Release v<version> triggered. Monitor CI: https://github.com/OhAhNicko/SleekCode/actions"
9. Remind: "Once CI completes, publish the draft release at https://github.com/OhAhNicko/SleekCode/releases"
