---
name: release
description: Bump version, commit, tag, and push to trigger a CI release build
argument-hint: "[version]"
---

Bump the app version and trigger a CI release build.

1. Determine target version:
   - If `$ARGUMENTS` is a valid semver (e.g. `0.2.0`): use it.
   - If `$ARGUMENTS` is empty or missing: run `gh release list --limit 1` to get the latest published release tag, then auto-increment the patch version (e.g. `0.1.2` → `0.1.3`). If no releases exist, fall back to reading `package.json` and incrementing that.
   - If `$ARGUMENTS` is invalid: STOP and ask.
2. Bump version in ALL THREE files (all must match):
   - `package.json` → `"version": "<version>"`
   - `src-tauri/Cargo.toml` → `version = "<version>"`
   - `src-tauri/tauri.conf.json` → `"version": "<version>"`
3. Run `npm run typecheck` — if it fails, STOP and report errors.
4. `git add -A && git commit -m "chore: bump version to <version>"`
5. `git push`
6. `git tag v<version> && git push --tags`
7. Report: "Release v<version> triggered. Monitor CI: https://github.com/OhAhNicko/SleekCode/actions"
8. Remind: "Once CI completes, publish the draft release at https://github.com/OhAhNicko/SleekCode/releases"
