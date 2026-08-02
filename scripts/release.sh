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
#   bash scripts/release.sh --draft-groups   # draft the commit split, then edit it
#   bash scripts/release.sh --dry-run        # print the whole plan, change nothing
#   bash scripts/release.sh                  # patch-bump, confirm, release
#   bash scripts/release.sh 0.3.0            # explicit version
#   bash scripts/release.sh --yes            # skip the confirmation prompt
#
# THE COMMIT SPLIT LIVES IN scripts/release-groups.txt, not in this file. One
# opaque "bump" commit makes a useless changelog, and the previous version of
# this script hardcoded the split, so it went stale the moment the tree moved
# on. Now: --draft-groups guesses a split from the current dirty tree, you edit
# the subjects, and the release uses it. Paths you leave out land in a final
# sweep commit, so nothing is ever silently dropped.
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
MANIFEST_REL="scripts/release-groups.txt"
PLACEHOLDER="<describe>"

DRY_RUN=0
DRAFT=0
ASSUME_YES=0
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --draft-groups) DRAFT=1 ;;
    -y|--yes)       ASSUME_YES=1 ;;
    -h|--help)      sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)             echo "unknown flag: $arg" >&2; exit 2 ;;
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
for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found on PATH."
done
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository."
cd "$ROOT"
MANIFEST="$ROOT/$MANIFEST_REL"

# ─── Draft mode: write a starter manifest and stop ────────────────────────────
# Guesses are path-based and deliberately crude — only you know what the work
# actually was. Every subject carries a placeholder the release refuses to ship.
if [ "$DRAFT" = 1 ]; then
  say "Drafting commit groups from the dirty tree"
  [ -e "$MANIFEST" ] && cp "$MANIFEST" "$MANIFEST.bak" && echo "   backed up existing manifest -> $MANIFEST_REL.bak"
  python3 - "$MANIFEST" "$PLACEHOLDER" <<'PY'
import re, subprocess, sys, collections

manifest, placeholder = sys.argv[1], sys.argv[2]

# first match wins; purely a starting point for the human to rewrite
RULES = [
    (r'[Gg]ame',                              'feat(games)'),
    (r'[Dd]ev-?[Ss]erver|spawn-dev-server',   'feat(dev-server)'),
    (r'[Tt]erminal',                          'feat(terminal)'),
    (r'/menu/|keybindings',                   'feat(menu)'),
    (r'overlay',                              'feat(overlay)'),
    (r'[Tt]ab[Bb]ar',                         'feat(tabs)'),
    (r'[Pp]ane|layout|render-pane',           'feat(layout)'),
    (r'theme|icons|installer-assets',         'feat(theme)'),
    (r'[Jj]ira',                              'feat(jira)'),
    (r'[Kk]anban',                            'feat(kanban)'),
    (r'[Ss]ettings',                          'feat(settings)'),
    (r'voice|whisper',                        'feat(voice)'),
]

out = subprocess.run(["git", "status", "--porcelain"],
                     capture_output=True, text=True, check=True).stdout
paths = []
for line in out.splitlines():
    p = line[3:].strip()
    if ' -> ' in p:               # renames
        p = p.split(' -> ', 1)[1]
    paths.append(p.strip('"'))

groups = collections.OrderedDict()
for p in paths:
    scope = next((s for rx, s in RULES if re.search(rx, p)), 'chore')
    groups.setdefault(scope, []).append(p)

# lockfiles are noise in a feature commit; let them fall through to the sweep
skip = {'package-lock.json', 'src-tauri/Cargo.lock'}

with open(manifest, 'w', encoding='utf-8') as f:
    f.write("""\
# Commit groups for the next release. Read by scripts/release.sh.
#
# FORMAT
#   A line with NO leading whitespace is a commit subject.
#   Lines indented by 2+ spaces are paths belonging to the subject above them.
#   Blank lines and # comments are ignored.
#
# RULES
#   - Replace every %s. The release REFUSES to run while one remains.
#   - A path may appear in only one group (first wins).
#   - Dirty paths you leave out are fine: they land in a final sweep commit.
#   - Paths that are missing, clean, or gitignored are skipped silently, so a
#     slightly stale manifest still works.
#   - Order here is the order the commits are made in.
#
# Groups below were GUESSED from file paths. Rewrite the subjects to say what
# the work actually did — they become the release changelog verbatim.
""" % placeholder)
    for scope, ps in groups.items():
        keep = [p for p in ps if p not in skip]
        if not keep:
            continue
        f.write("\n%s: %s\n" % (scope, placeholder))
        for p in sorted(keep):
            f.write("  %s\n" % p)

print("   %d group(s), %d path(s)" % (len(groups), len(paths)))
PY
  echo
  echo "   Wrote $MANIFEST_REL"
  echo "   Edit the subjects (replace every $PLACEHOLDER), then run:"
  echo "     bash scripts/release.sh --dry-run"
  exit 0
fi

# ─── Remaining tools are only needed for an actual release ────────────────────
for tool in gh node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' not found on PATH."
done

say "Pre-flight"
echo "   repo:   $ROOT"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"

BRANCH="$(git branch --show-current)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH'. Releases cut from main — run: git switch main"

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

git rev-parse "v$VERSION" >/dev/null 2>&1 && die "tag v$VERSION already exists locally. Pick another version."
gh release view "v$VERSION" >/dev/null 2>&1 && die "release v$VERSION already exists on GitHub. Pick another version."

PREV="$(gh release list --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
[ -n "$PREV" ] || PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"
echo "   changelog base: ${PREV:-<none — first release>}"

# ─── 2. Read the manifest ─────────────────────────────────────────────────────
# Parsed into two parallel arrays: G_SUBJECT[i] and G_PATHS[i] (space-joined,
# safe because no path in this repo contains a space — asserted below).
declare -a G_SUBJECT=() G_PATHS=()

if [ -f "$MANIFEST" ]; then
  say "Reading $MANIFEST_REL"
  subject=""; acc=""
  while IFS= read -r line || [ -n "$line" ]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    [ -z "$trimmed" ] && continue
    case "$trimmed" in \#*) continue ;; esac

    case "$line" in
      [[:space:]]*)
        case "$trimmed" in *" "*) die "path contains a space in $MANIFEST_REL: '$trimmed'" ;; esac
        acc="$acc $trimmed"
        ;;
      *)
        if [ -n "$subject" ]; then G_SUBJECT+=("$subject"); G_PATHS+=("$acc"); fi
        subject="$trimmed"; acc=""
        ;;
    esac
  done < "$MANIFEST"
  if [ -n "$subject" ]; then G_SUBJECT+=("$subject"); G_PATHS+=("$acc"); fi

  for i in "${!G_SUBJECT[@]}"; do
    case "${G_SUBJECT[$i]}" in
      *"$PLACEHOLDER"*)
        die "$MANIFEST_REL still contains $PLACEHOLDER on: '${G_SUBJECT[$i]}'
       Replace every placeholder subject with what the work actually did —
       these lines become the release changelog verbatim." ;;
    esac
  done
  echo "   ${#G_SUBJECT[@]} group(s)"
else
  warn "no $MANIFEST_REL — everything dirty goes into ONE sweep commit,"
  warn "which makes a poor changelog. Run: bash scripts/release.sh --draft-groups"
fi

# ─── 3. Plan ──────────────────────────────────────────────────────────────────
# Skip a path if it is gitignored (git add on an ignored path is a hard error,
# not a no-op, so with set -e one would abort the whole release), or if it is
# absent AND untracked. A deleted-but-tracked path IS kept, so deletions stage.
usable() {
  git check-ignore -q "$1" 2>/dev/null && return 1
  [ -e "$1" ] && return 0
  git ls-files --error-unmatch -- "$1" >/dev/null 2>&1
}

say "Plan"
CLAIMED="$(mktemp)"; trap 'rm -f "$CLAIMED"' EXIT
PLANNED=0
for i in "${!G_SUBJECT[@]}"; do
  hits=""
  for p in ${G_PATHS[$i]}; do
    usable "$p" || continue
    [ -z "$(git status --porcelain -- "$p")" ] && continue
    hits="$hits $p"
    git status --porcelain -- "$p" | sed 's/^...//' >> "$CLAIMED"
  done
  n=$(printf '%s\n' $hits | grep -c . || true)
  if [ "$n" != "0" ]; then
    PLANNED=$((PLANNED + 1))
    printf '   \033[1m%s\033[0m  (%s path(s))\n' "${G_SUBJECT[$i]}" "$n"
    for p in $hits; do printf '      %s\n' "$p"; done
  fi
done

SWEEP="$(git status --porcelain | sed 's/^...//' | sort -u | comm -23 - <(sort -u "$CLAIMED") || true)"
SWEEP_N=$(printf '%s\n' "$SWEEP" | grep -c . || true)
if [ "$SWEEP_N" != "0" ]; then
  printf '   \033[1mchore: sweep remaining working-tree changes\033[0m  (%s path(s))\n' "$SWEEP_N"
  printf '%s\n' "$SWEEP" | sed 's/^/      /'
fi
echo "   chore: bump version to $VERSION"
echo "   tag v$VERSION -> push -> CI builds, signs and auto-publishes"

if [ "$PLANNED" = "0" ] && [ "$SWEEP_N" = "0" ]; then
  warn "working tree is clean — this will be a version-bump-only release."
fi

# ─── 4. Confirm ───────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = 1 ]; then
  echo; say "Dry run — nothing changed, committed, tagged or pushed."
  exit 0
fi
if [ "$ASSUME_YES" = 0 ]; then
  echo
  printf 'Proceed with release v%s? [y/N] ' "$VERSION"
  read -r reply < /dev/tty
  case "$reply" in y|Y|yes|YES) ;; *) die "aborted by user. Nothing was changed." ;; esac
fi

# ─── 5. Commit the groups ─────────────────────────────────────────────────────
say "Committing"
for i in "${!G_SUBJECT[@]}"; do
  keep=""
  for p in ${G_PATHS[$i]}; do usable "$p" && keep="$keep $p"; done
  [ -z "$keep" ] && continue
  git add -A -- $keep
  git diff --cached --quiet && continue
  git commit -q -m "${G_SUBJECT[$i]}"
  printf '   %s\n' "${G_SUBJECT[$i]}"
done

git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "chore: sweep remaining working-tree changes"
  echo "   chore: sweep remaining working-tree changes"
fi

# ─── 6. Bump the version in all four files ────────────────────────────────────
say "Bumping version to $VERSION"
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

PJ=$(node -p "require('./package.json').version")
TC=$(node -p "require('./src-tauri/tauri.conf.json').version")
CT=$(grep -m1 '^version = ' src-tauri/Cargo.toml | cut -d'"' -f2)
CL=$(grep -A1 '^name = "made"$' src-tauri/Cargo.lock | grep '^version = ' | cut -d'"' -f2)
echo "   package.json=$PJ  tauri.conf.json=$TC  Cargo.toml=$CT  Cargo.lock=$CL"
[ "$PJ" = "$VERSION" ] && [ "$TC" = "$VERSION" ] && [ "$CT" = "$VERSION" ] && [ "$CL" = "$VERSION" ] \
  || die "version files disagree after bump — fix by hand before retrying."

# ─── 7. Typecheck ─────────────────────────────────────────────────────────────
# Only typecheck: `npm run build` is CI's job, and the bundle is rebuilt there.
say "Typechecking"
npm run typecheck || die "typecheck failed. The workstream commits are made and the version
       files are bumped but not committed. Fix the errors, then re-run with the
       SAME version — it is idempotent: bash scripts/release.sh $VERSION"

# ─── 8. Commit the bump and push ──────────────────────────────────────────────
say "Committing bump and pushing"
git add -A
git diff --cached --quiet || git commit -q -m "chore: bump version to $VERSION"
git push origin main

# ─── 9. Build the release notes ───────────────────────────────────────────────
say "Building changelog"
NOTES="$(mktemp)"
trap 'rm -f "$CLAIMED" "$NOTES"' EXIT
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
echo "   ---8<---"; sed 's/^/   /' "$NOTES"; echo "   --->8---"

# ─── 10. Tag and push — this is what triggers CI ──────────────────────────────
say "Tagging v$VERSION and pushing (triggers CI)"
git tag "v$VERSION"
git push origin "v$VERSION"

# ─── 11. Seed the release notes ───────────────────────────────────────────────
# Race: CI may create the release first. Try create, fall back to edit.
say "Publishing release notes"
if gh release create "v$VERSION" --title "MADE v$VERSION" --notes-file "$NOTES" --draft 2>/dev/null; then
  echo "   created draft release v$VERSION"
else
  gh release edit "v$VERSION" --title "MADE v$VERSION" --notes-file "$NOTES" \
    || die "could not create or edit release v$VERSION. The tag is pushed and CI is
       running — add notes by hand: gh release edit v$VERSION --notes-file <file>"
  echo "   updated existing release v$VERSION (CI had created it)"
fi

# ─── 12. Report ───────────────────────────────────────────────────────────────
echo
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

  The manifest ($MANIFEST_REL) is now stale. Before the next release:
    bash scripts/release.sh --draft-groups
EOF

git status -sb | head -3
