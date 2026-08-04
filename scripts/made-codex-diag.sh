#!/usr/bin/env bash
# MADE Codex context diagnostic — run in WSL, in the project MADE has open.
# Prints only facts; changes nothing.
CWD="${1:-$PWD}"
echo "PROJECT: $CWD"
echo

echo "=== 1. Rollout files whose session_meta cwd matches this project ==="
n=0
for rf in $(find ~/.codex/sessions/ -name '*.jsonl' -type f 2>/dev/null | xargs ls -1t 2>/dev/null | head -60); do
  if head -1 "$rf" 2>/dev/null | grep -qF "\"cwd\":\"$CWD\""; then
    id=$(basename "$rf" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    has=$(grep -c '"model_context_window"' "$rf" 2>/dev/null)
    echo "  $id  ctx_lines=$has  $(basename "$rf")"
    n=$((n+1)); [ $n -ge 5 ] && break
  fi
done
[ $n -eq 0 ] && echo "  NONE — the __latest__ scoping finds nothing for this cwd"
echo

echo "=== 2. threads rows for this cwd: unfiltered vs MADE's filter ==="
python3 - "$CWD" <<'PY'
import sqlite3, os, sys
db = os.path.expanduser('~/.codex/state_5.sqlite')
if not os.path.exists(db):
    print("  no state_5.sqlite (older Codex — SQLite path unused)"); raise SystemExit
c = sqlite3.connect('file:'+db+'?mode=ro', uri=True)
p = sys.argv[1]
F = ("AND COALESCE(archived,0)=0 AND agent_role IS NULL "
     "AND COALESCE(thread_source,'user')='user' "
     "AND id NOT IN (SELECT child_thread_id FROM thread_spawn_edges)")
def rows(f):
    # lower() on BOTH sides — Codex stores the cwd lowercased, and this must
    # mirror what MADE actually queries or the output misleads.
    try:
        return c.execute(f"SELECT id FROM threads WHERE lower(cwd)=lower(?) {f} ORDER BY updated_at DESC LIMIT 20",(p,)).fetchall()
    except sqlite3.Error as e:
        return [("ERR: %s" % e,)]
old = [r[0] for r in rows("")]
new = [r[0] for r in rows(F)]
print(f"  unfiltered: {len(old)}   filtered: {len(new)}")
if old and not new:
    print("  *** THE FILTER EXCLUDES EVERY THREAD FOR THIS PROJECT ***")
for i in old[:6]:
    try:
        r = c.execute("""SELECT COALESCE(source,''), COALESCE(thread_source,'<NULL>'),
                                COALESCE(agent_role,'<NULL>'), COALESCE(archived,0),
                                substr(COALESCE(title,''),1,40)
                         FROM threads WHERE id=?""",(i,)).fetchone()
        spawned = c.execute("SELECT 1 FROM thread_spawn_edges WHERE child_thread_id=?",(i,)).fetchone()
    except sqlite3.Error as e:
        print("  ", i, "query error", e); continue
    print(f"  {'KEEP' if i in new else 'DROP'} {i[:8]}  source={r[0]} thread_source={r[1]} "
          f"agent_role={r[2]} archived={r[3]} spawned={'Y' if spawned else 'N'}  | {r[4]}")
print()
print("  distinct marker values across ALL threads:")
try:
    for r in c.execute("""SELECT COALESCE(source,''), COALESCE(thread_source,'<NULL>'),
                                 COALESCE(agent_role,'<NULL>'), COUNT(*)
                          FROM threads GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 10"""):
        print("   ", r)
except sqlite3.Error as e:
    print("   ", e)
PY
echo

echo "=== 3. Does each project thread id have a rollout FILE? ==="
python3 - "$CWD" <<'PY'
import sqlite3, os, sys, subprocess
db = os.path.expanduser('~/.codex/state_5.sqlite')
if not os.path.exists(db): raise SystemExit
c = sqlite3.connect('file:'+db+'?mode=ro', uri=True)
try:
    ids = [r[0] for r in c.execute("SELECT id FROM threads WHERE lower(cwd)=lower(?) ORDER BY updated_at DESC LIMIT 5",(sys.argv[1],))]
except sqlite3.Error:
    raise SystemExit
base = os.path.expanduser('~/.codex/sessions')
for i in ids:
    hit = subprocess.run(["find", base, "-name", f"*{i}*.jsonl"], capture_output=True, text=True).stdout.strip()
    print(f"  {i[:8]}  rollout={'YES' if hit else 'NO — cli_session_exists would say gone'}")
PY
echo

echo "=== 4. MADE's resolved-path caches ==="
ls -1 /tmp/made-sessionpath-* 2>/dev/null | head -5 || echo "  (none)"
echo
echo "=== 5. python3 present for the SQLite queries? ==="
command -v python3 >/dev/null && python3 -c "import sqlite3; print('  yes, sqlite3 module ok')" || echo "  *** NO python3 — every SQLite lookup silently returns nothing ***"
