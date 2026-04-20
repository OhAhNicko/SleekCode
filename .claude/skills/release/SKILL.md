---
name: release
description: Bump version, commit, tag, push, and publish draft release with auto-generated changelog notes
argument-hint: "[version]"
---

Bump the app version, trigger a CI release build, and populate the GitHub release body with a changelog generated from git history. The changelog feeds the in-app ChangelogModal after auto-updates, so every release needs real notes — never leave the default "See the assets below" placeholder.

1. Determine target version:
   - If `$ARGUMENTS` is a valid semver (e.g. `0.2.0`): use it.
   - If `$ARGUMENTS` is empty or missing: run `gh release list --limit 1` to get the latest published release tag, then auto-increment the patch version (e.g. `0.1.2` → `0.1.3`). If no releases exist, fall back to reading `package.json` and incrementing that.
   - If `$ARGUMENTS` is invalid: STOP and ask.
2. Capture the previous tag for changelog generation:
   - `previous_tag=$(gh release list --limit 1 --json tagName --jq '.[0].tagName')`.
   - If empty, fall back to `git describe --tags --abbrev=0 2>/dev/null`. If still empty (first-ever release), skip the changelog step and use a one-liner body like "Initial release."
3. Bump version in ALL THREE files (all must match):
   - `package.json` → `"version": "<version>"`
   - `src-tauri/Cargo.toml` → `version = "<version>"`
   - `src-tauri/tauri.conf.json` → `"version": "<version>"`
4. Run `npm run typecheck` — if it fails, STOP and report errors.
5. `git add -A && git commit -m "chore: bump version to <version>"`
6. `git push`
7. Build the release notes body from git log since the previous tag:
   - `commits=$(git log ${previous_tag}..HEAD --no-merges --pretty=format:"- %s")`
   - Skip commits whose subject starts with `chore: bump version` (they are pure version bumps and add noise).
   - Prepend `## What's changed\n\n` and append `\n\n**Full changelog**: https://github.com/OhAhNicko/SleekCode/compare/${previous_tag}...v<version>`.
   - If the commit list is empty after filtering, fall back to `- Maintenance release.` so the body is never empty.
8. `git tag v<version> && git push --tags` — this triggers CI (`.github/workflows/release.yml`), which creates/updates a draft release via `tauri-apps/tauri-action@v0.6`.
9. Populate the draft release with the generated notes:
   - First attempt: `gh release create v<version> --title "EzyDev v<version>" --notes "$body" --draft`.
   - If that fails because CI already created the release, fall back to: `gh release edit v<version> --title "EzyDev v<version>" --notes "$body"`.
   - Pass `--notes` via a HEREDOC file (`--notes-file`) if the body contains special shell characters.
10. Report: "Release v<version> triggered. Monitor CI: https://github.com/OhAhNicko/SleekCode/actions"
11. Remind: "Once CI finishes uploading artifacts, review and publish the draft release at https://github.com/OhAhNicko/SleekCode/releases — the notes will appear in the in-app changelog popup after the next auto-update."
