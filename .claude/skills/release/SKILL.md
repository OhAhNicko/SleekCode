---
name: release
description: Bump version, commit, tag, push, and auto-publish a release with auto-generated changelog notes
argument-hint: "[version]"
---

Bump the app version, trigger a CI release build, and populate the GitHub release body with a changelog generated from git history. The changelog feeds the in-app ChangelogModal after auto-updates, so every release needs real notes — never leave the default "See the assets below" placeholder.

0. Branch & working-tree pre-flight (do this FIRST — releases must cut from `main`, and `git add -A` in step 5 sweeps EVERYTHING dirty into the release):
   - `current=$(git branch --show-current)` and `git status --short`.
   - **Standing consent: always release everything dirty (user decision, 2026-07-30).** Do NOT ask for confirmation about the dirty tree — sweep every modified/untracked file (including other sessions' WIP) into the release so the tree ends clean. Still LIST the swept files in the final report so the user sees what shipped, and still commit distinct workstreams as their OWN `feat/fix(...)` commits (read the diff if unsure what a workstream is — don't guess) BEFORE the version bump, so the changelog gets real subjects instead of one opaque bump commit.
   - **Already on `main` and clean** → skip to step 1.
   - **On a feature branch (multi-branch flow — the branch holds the work, `main` is the release trunk):**
     a. `git fetch origin`, then confirm a clean fast-forward is possible:
        - `git rev-list --count main..$current` → commits the branch is ahead (should be > 0), and
        - `git rev-list --count $current..origin/main` → **must be 0** (the branch already contains `origin/main`). If it's > 0, `main` advanced independently — STOP and ask; a plain fast-forward would drop those commits, so a merge/rebase is needed first.
     b. **Commit the feature WIP on the branch as its OWN `feat/fix(...)` commit(s)** describing the work — NOT the version bump. Keep the feature commit(s) and the later `chore: bump version` commit separate so history reads cleanly. If unsure what the WIP is, read the diff and write an accurate message (don't guess).
     c. Fast-forward `main` up to the branch: `git switch main && git merge --ff-only $current`. Use `git switch` (non-destructive once the tree is clean); never `git checkout`/`reset`/`restore` files — see Rule #1 in CLAUDE.md.
     d. Continue with step 1 onward **from `main`** — the version bump, commit, and tag all land on `main` (the source of truth), not the feature branch.
   - After the release goes out, the local feature branch is fully merged into `main`; ask the user before deleting it.

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
   - Also `src-tauri/Cargo.lock` (the `made` package entry). A running `tauri:dev` cargo watcher on Windows auto-regenerates it to `<version>` the moment `Cargo.toml` is bumped, and step 5's `git add -A` commits it — so it usually just works. If no dev server is running, edit the `made` entry by hand so the lock doesn't drift from `Cargo.toml` and fail CI.
4. Run `npm run typecheck` — if it fails, STOP and report errors.
5. `git add -A && git commit -m "chore: bump version to <version>"`
6. `git push`
7. Build the release notes body from git log since the previous tag:
   - `commits=$(git log ${previous_tag}..HEAD --no-merges --pretty=format:"- %s")`
   - Skip commits whose subject starts with `chore: bump version` (they are pure version bumps and add noise).
   - Prepend `## What's changed\n\n` and append `\n\n**Full changelog**: https://github.com/OhAhNicko/SleekCode/compare/${previous_tag}...v<version>`.
   - If the commit list is empty after filtering, fall back to `- Maintenance release.` so the body is never empty.
8. `git tag v<version> && git push --tags` — this triggers CI (`.github/workflows/release.yml`), which builds/signs via `tauri-apps/tauri-action@v0.6` and then **auto-publishes** the release (the `publish` job runs `gh release edit --draft=false` after the build matrix, even if a platform build fails). No manual publish step is needed.
9. Populate the draft release with the generated notes:
   - First attempt: `gh release create v<version> --title "MADE v<version>" --notes "$body" --draft`.
   - If that fails because CI already created the release, fall back to: `gh release edit v<version> --title "MADE v<version>" --notes "$body"`.
   - Pass `--notes` via a HEREDOC file (`--notes-file`) if the body contains special shell characters.
10. Report: "Release v<version> triggered. Monitor CI: https://github.com/OhAhNicko/SleekCode/actions"
11. No manual publish needed — CI auto-publishes the release once the build matrix finishes uploading artifacts (the `publish` job in `.github/workflows/release.yml`). Note for the operator: `gh run watch` can report success on a failed run — verify the real outcome with `gh run view <id> --json conclusion,jobs`, and confirm the release went live by curling `https://github.com/OhAhNicko/SleekCode/releases/latest/download/latest.json` (it should serve v<version>). The notes feed the in-app changelog popup after the next auto-update.
