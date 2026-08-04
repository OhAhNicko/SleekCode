#!/usr/bin/env bash
# MADE Codex diagnostic #2 — why does `threads` have no row for this cwd,
# when rollout files for it clearly exist? Read-only.
CWD="${1:-$PWD}"
echo "PROJECT: $CWD"
echo

echo "=== A. What cwd do recent source='cli' threads actually record? ==="
python3 - "$CWD" <<'PY'
import sqlite3, os, sys
db = os.path.expanduser('~/.codex/state_5.sqlite')
c = sqlite3.connect('file:'+db+'?mode=ro', uri=True)
want = sys.argv[1]
print("  recent cli threads:")
for r in c.execute("""SELECT id, COALESCE(source,''),
                             CASE WHEN cwd IS NULL THEN '<NULL>' ELSE cwd END,
                             COALESCE(updated_at,0)
                      FROM threads WHERE source='cli'
                      ORDER BY updated_at DESC LIMIT 10"""):
    mark = "  <-- MATCHES" if r[2] == want else ""
    print(f"    {r[0][:8]}  cwd={r[2]!r}{mark}")
n_null = c.execute("SELECT COUNT(*) FROM threads WHERE cwd IS NULL").fetchone()[0]
n_all  = c.execute("SELECT COUNT(*) FROM threads").fetchone()[0]
print(f"\n  cwd IS NULL: {n_null} of {n_all} threads")
print("  any cwd containing the project basename:")
base = os.path.basename(want.rstrip('/'))
rows = c.execute("SELECT DISTINCT cwd FROM threads WHERE cwd LIKE ?", ('%'+base+'%',)).fetchall()
for r in rows[:10]:
    print(f"    {r[0]!r}   {'EXACT' if r[0]==want else 'differs'}")
if not rows:
    print("    (none)")
PY
echo

echo "=== B. Are THIS PROJECT's rollout ids in the threads table at all? ==="
python3 - "$CWD" <<'PY'
import sqlite3, os, sys, subprocess, re
db = os.path.expanduser('~/.codex/state_5.sqlite')
c = sqlite3.connect('file:'+db+'?mode=ro', uri=True)
base = os.path.expanduser('~/.codex/sessions')
want = sys.argv[1]
out = subprocess.run(["bash","-c",
    f"find {base} -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -60"],
    capture_output=True, text=True).stdout.split()
hits = 0
for rf in out:
    try:
        first = open(rf, encoding='utf-8', errors='replace').readline()
    except OSError:
        continue
    if f'"cwd":"{want}"' not in first:
        continue
    m = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', os.path.basename(rf))
    if not m:
        continue
    sid = m.group(0)
    row = c.execute("SELECT 1 FROM threads WHERE id=?", (sid,)).fetchone()
    print(f"    {sid[:8]}  in threads: {'YES' if row else 'NO'}")
    hits += 1
    if hits >= 6:
        break
if not hits:
    print("    (no rollouts matched this cwd in the newest 60 files)")
PY
echo

echo "=== C. Does MADE's JSONL fallback pipeline find a session? ==="
echo "  (this is the exact command get_codex_session_id runs when SQLite returns nothing)"
find ~/.codex/sessions -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -20 \
  | xargs -I{} head -1 {} 2>/dev/null \
  | grep -i "\"cwd\":\"$CWD\"" \
  | grep -oE '"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"' \
  | sed 's/"id":"//;s/"//' | head -3 | sed 's/^/    found: /'
echo "  (blank above = the fallback finds nothing either)"
echo
echo "  how many rollout files exist in total, and how deep is this project in the list?"
total=$(find ~/.codex/sessions -name '*.jsonl' -type f 2>/dev/null | wc -l)
pos=$(find ~/.codex/sessions -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null \
      | grep -n . | while read -r l; do
          n="${l%%:*}"; p="${l#*:}"
          head -1 "$p" 2>/dev/null | grep -qF "\"cwd\":\"$CWD\"" && echo "$n" && break
        done)
echo "    total rollouts: $total   newest one for this project is #${pos:-none} in mtime order"
echo "    (MADE's fallback only looks at the newest 20 — #>20 means it never sees it)"
