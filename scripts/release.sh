#!/usr/bin/env bash
#
# Cut a MADE release: group the dirty tree into real commits, bump the version
# in all four files, tag, push, and seed the GitHub release notes.
#
# RUN THIS ON THE WINDOWS/WSL DEV HOST. The macOS side of this project is an
# SMB client of that host: it has no GitHub credentials, and its node_modules
# holds win32 native binaries (installing the darwin ones would break the
# Windows build). So releases are cut here, where git push and gh work.
#
#   bash scripts/release.sh                # patch-bump from the latest release
#   bash scripts/release.sh 0.3.0          # explicit version
#   bash scripts/release.sh --dry-run      # print the plan, change nothing
#   bash scripts/release.sh 0.3.0 --dry-run
#
# Pushing the tag is what triggers CI (.github/workflows/release.yml). CI builds
# and signs via tauri-action, then auto-publishes — its `publish` job runs
# `gh release edit --draft=false` after the build matrix, even if one platform
# fails. There is no manual publish step.
#
# This script never runs git checkout/reset/restore/stash. If a step fails it
# stops and tells you the state it left behind; nothing is rolled back for you.

set -euo pipefail

REPO_SLUG="OhAhNicko/SleekCode"
DRY_RUN=0
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)
      if [[ "$arg" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        VERSION="$arg"
      else
        echo "ERROR: '$arg' is not a valid semver (expected e.g. 0.3.0)" >&2
        exit 2
      fi
      ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else eval "$@"; fi; }

# ─── 0. Pre-flight ────────────────────────────────────────────────────────────
say "Pre-flight"

for tool in git gh node npm python3; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found on PATH."
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository."
cd "$ROOT"
echo "   repo:   $ROOT"

gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH'. Releases cut from main — run: git switch main"

say "Fetching origin"
run "git fetch origin --tags --quiet"

if [ "$DRY_RUN" = 0 ]; then
  BEHIND="$(git rev-list --count HEAD..origin/main)"
  [ "$BEHIND" = "0" ] || die "main is $BEHIND commit(s) behind origin/main. Pull first (git pull --ff-only)."
fi

# ─── 1. Target version ────────────────────────────────────────────────────────
CURRENT="$(node -p "require('./package.json').version")"

if [ -z "$VERSION" ]; then
  LATEST="$(gh release list --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
  BASE="${LATEST#v}"
  [ -n "$BASE" ] || BASE="$CURRENT"
  IFS='.' read -r MA MI PA <<<"$BASE"
  VERSION="${MA}.${MI}.$((PA + 1))"
  echo "   latest release: ${LATEST:-<none>}   package.json: $CURRENT"
fi

say "Target version: $VERSION  (from $CURRENT)"

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  die "tag v$VERSION already exists locally. Pick another version."
fi
if gh release view "v$VERSION" >/dev/null 2>&1; then
  die "release v$VERSION already exists on GitHub. Pick another version."
fi

# ─── 2. Previous tag, for the changelog range ─────────────────────────────────
PREV="$(gh release list --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
[ -n "$PREV" ] || PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"
echo "   changelog base: ${PREV:-<none — first release>}"

# ─── 3. Group the dirty tree into real commits ────────────────────────────────
# One opaque "bump" commit makes a useless changelog, so distinct workstreams
# get their own subjects first. Groups are tolerant: a path that is missing or
# already clean is skipped, so this still works if the tree has moved on.
#
# Some files genuinely span two workstreams (index.css carries both the Heads
# :root block and the UI-font faces). Those land in their primary group rather
# than being split hunk-by-hunk — a script must not guess at hunk ownership.

commit_group() {
  local msg="$1"; shift
  local -a keep=()
  local p
  for p in "$@"; do
    # Skip gitignored paths. `git add -- <ignored>` is a hard error, not a
    # no-op, so with `set -e` one ignored path would abort the whole release.
    # docs/ is ignored in this repo ("local only"), and it is easy to add a
    # path here without noticing that.
    git check-ignore -q "$p" 2>/dev/null && continue
    if [ -e "$p" ] || git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
      keep+=("$p")
    fi
  done
  [ ${#keep[@]} -eq 0 ] && return 0

  if [ "$DRY_RUN" = 1 ]; then
    local changed
    changed="$(git status --porcelain -- "${keep[@]}" | wc -l | tr -d ' ')"
    [ "$changed" != "0" ] && printf '   [dry-run] commit (%s files): %s\n' "$changed" "$msg"
    return 0
  fi

  git add -A -- "${keep[@]}"
  if git diff --cached --quiet; then return 0; fi
  git commit -q -m "$msg"
  printf '   %s\n' "$msg"
}

say "Committing workstreams"

commit_group "feat(theme): Heads as the default theme, Heads-inspired app icon and startup colour" \
  src/lib/themes.ts src/index.css src/overlay/overlay.css \
  src-tauri/icons src-tauri/installer-assets src-tauri/tauri.conf.json \
  src-tauri/src/lib.rs src-tauri/src/preview_proxy.rs src-tauri/src/overlay \
  src/components/AppErrorBoundary.tsx public/browser-security-check.html \
  public/made-logo.svg scripts/generate-icons.py scripts/release.sh \
  index.html .gitattributes package.json

commit_group "feat(ui): selectable UI font (Inter / Atkinson Hyperlegible Next)" \
  src/fonts src/lib/ui-fonts.ts src/store/themeSlice.ts src/components/SettingsPane.tsx

commit_group "feat(dev-server): per-project host flag and port controls" \
  src/components/DevServerTab.tsx src/components/DevServerTerminalHost.tsx \
  src/components/ServersPanel.tsx src/lib/server-commands.ts

commit_group "feat(jira): ticket rail canvas and project handling" \
  src/components/JiraTicketRail.tsx src/components/NewJiraTicketModal.tsx \
  src/lib/jira-project.ts

commit_group "chore: in-flight WIP (pty/session context, prompt modal, menu providers, keychain)" \
  src/App.tsx src/main.tsx src/hooks src/lib/keychain.ts src/lib/menu \
  src/lib/prompt-modal.ts src/lib/terminal-config.ts src/store/index.ts \
  src/components/PromptModal.tsx src/overlay/OverlayRoot.tsx .gitignore

# Anything left (new files from another session, generated lockfiles, …).
if [ "$DRY_RUN" = 0 ]; then
  git add -A
  if ! git diff --cached --quiet; then
    git commit -q -m "chore: sweep remaining working-tree changes"
    echo "   chore: sweep remaining working-tree changes"
  fi
else
  LEFT="$(git status --porcelain | wc -l | tr -d ' ')"
  [ "$LEFT" != "0" ] && echo "   [dry-run] $LEFT path(s) total would be swept into the commits above"
fi

# ─── 4. Bump the version in all four files ────────────────────────────────────
say "Bumping version to $VERSION"

if [ "$DRY_RUN" = 1 ]; then
  echo "   [dry-run] package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, src-tauri/Cargo.lock"
else
python3 - "$VERSION" <<'PY'
import re, sys, pathlib

v = sys.argv[1]

def sub(path, pattern, repl, flags=0):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    new, n = re.subn(pattern, repl, s, count=1, flags=flags)
    if n != 1:
        sys.exit("ERROR: no version match in %s (pattern %r)" % (path, pattern))
    p.write_text(new, encoding="utf-8")
    print("   %-28s -> %s" % (path, v))

# Both JSON files carry the app version as the first 2-space-indented
# "version" key; targeted so nested dependency versions can never match.
sub("package.json",              r'^  "version": "[^"]*"', '  "version": "%s"' % v, re.M)
sub("src-tauri/tauri.conf.json", r'^  "version": "[^"]*"', '  "version": "%s"' % v, re.M)

# Cargo.toml: the only line-anchored `version =` is [package].version;
# dependency versions are all inline in `{ version = "..." }` tables.
sub("src-tauri/Cargo.toml",      r'^version = "[^"]*"',    'version = "%s"' % v, re.M)

# Cargo.lock: the version line belonging to the `made` package entry. A dev
# cargo watcher usually rewrites this on its own, but not if none is running,
# and a lock that disagrees with Cargo.toml fails CI.
sub("src-tauri/Cargo.lock",      r'(?m)^name = "made"\nversion = "[^"]*"',
    'name = "made"\nversion = "%s"' % v)
PY

  # All four must agree, or the Windows build and the updater disagree later.
  PJ=$(node -p "require('./package.json').version")
  TC=$(node -p "require('./src-tauri/tauri.conf.json').version")
  CT=$(grep -m1 '^version = ' src-tauri/Cargo.toml | cut -d'"' -f2)
  CL=$(grep -A1 '^name = "made"$' src-tauri/Cargo.lock | grep '^version = ' | cut -d'"' -f2)
  echo "   package.json=$PJ  tauri.conf.json=$TC  Cargo.toml=$CT  Cargo.lock=$CL"
  [ "$PJ" = "$VERSION" ] && [ "$TC" = "$VERSION" ] && [ "$CT" = "$VERSION" ] && [ "$CL" = "$VERSION" ] \
    || die "version files disagree after bump — fix by hand before retrying."
fi

# ─── 5. Typecheck ─────────────────────────────────────────────────────────────
# Only typecheck: `npm run build` is CI's job, and the bundle is rebuilt there.
say "Typechecking"
if [ "$DRY_RUN" = 1 ]; then
  echo "   [dry-run] npm run typecheck"
else
  npm run typecheck || die "typecheck failed. Version files are already bumped and workstream commits are made — fix the errors, then re-run with the SAME version: bash scripts/release.sh $VERSION"
fi

# ─── 6. Commit the bump and push ──────────────────────────────────────────────
say "Committing bump and pushing"
run "git add -A"
if [ "$DRY_RUN" = 0 ]; then
  git diff --cached --quiet || git commit -q -m "chore: bump version to $VERSION"
fi
run "git push origin main"

# ─── 7. Build the release notes ───────────────────────────────────────────────
say "Building changelog"
NOTES="$(mktemp)"
trap 'rm -f "$NOTES"' EXIT

{
  echo "## What's changed"
  echo
  if [ -n "$PREV" ]; then
    # Drop pure version bumps — they are noise in a changelog.
    git log "${PREV}..HEAD" --no-merges --pretty=format:'- %s' \
      | grep -v '^- chore: bump version' || true
  fi
} > "$NOTES"

# Never ship an empty body: the in-app ChangelogModal renders this verbatim
# after an auto-update.
if [ "$(grep -c '^- ' "$NOTES" || true)" = "0" ]; then
  echo "- Maintenance release." >> "$NOTES"
fi

if [ -n "$PREV" ]; then
  printf '\n\n**Full changelog**: https://github.com/%s/compare/%s...v%s\n' \
    "$REPO_SLUG" "$PREV" "$VERSION" >> "$NOTES"
fi

echo "   ---8<---"
sed 's/^/   /' "$NOTES"
echo "   --->8---"

# ─── 8. Tag and push — this is what triggers CI ───────────────────────────────
say "Tagging v$VERSION and pushing (triggers CI)"
run "git tag \"v$VERSION\""
run "git push origin \"v$VERSION\""

# ─── 9. Seed the release notes ────────────────────────────────────────────────
# Race: CI may create the release first. Try create, fall back to edit.
say "Publishing release notes"
if [ "$DRY_RUN" = 1 ]; then
  echo "   [dry-run] gh release create v$VERSION --title \"MADE v$VERSION\" --notes-file <changelog> --draft"
else
  if gh release create "v$VERSION" --title "MADE v$VERSION" --notes-file "$NOTES" --draft 2>/dev/null; then
    echo "   created draft release v$VERSION"
  else
    gh release edit "v$VERSION" --title "MADE v$VERSION" --notes-file "$NOTES" \
      || die "could not create or edit release v$VERSION. The tag is pushed and CI is running — add notes by hand with: gh release edit v$VERSION --notes-file <file>"
    echo "   updated existing release v$VERSION (CI had created it)"
  fi
fi

# ─── 10. Report ───────────────────────────────────────────────────────────────
echo
if [ "$DRY_RUN" = 1 ]; then
  say "Dry run complete — nothing was changed, committed, tagged or pushed."
  exit 0
fi

say "Release v$VERSION triggered."
cat <<EOF

  Monitor CI:  https://github.com/$REPO_SLUG/actions
  Release:     https://github.com/$REPO_SLUG/releases/tag/v$VERSION

  CI auto-publishes once the build matrix finishes — no manual publish needed.

  Verify for real (gh run watch can report success on a failed run):
    gh run list --limit 1
    gh run view <id> --json conclusion,jobs
    curl -sL https://github.com/$REPO_SLUG/releases/latest/download/latest.json | head -5

  The last command should report v$VERSION once publishing completes.
EOF

git status -sb | head -3
