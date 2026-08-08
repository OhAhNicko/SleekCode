#!/usr/bin/env bash
# NexusMind crash harness — mirror every crash-vulnerable artifact onto the
# Windows-disk project tree (docs/nexusmind/), which survives terminal death,
# WSL shutdown, and even a WSL distro loss.
#
# What dies where, and what this script saves:
#   - /tmp scratchpads (session-specific)         → died once already; nothing
#     is sourced from /tmp any more.
#   - In-memory agent contexts / task lists       → unrecoverable by design;
#     recovery works from the durable briefs + STATUS.md instead.
#   - ~/.claude (WSL ext4): plans, transcripts,   → survives terminal death but
#     workflow journals                             NOT a distro loss → mirrored
#     here on every run.
#
# Usage: bash scripts/nexusmind-checkpoint.sh
# Idempotent; safe to run any time, including while agents are working.

set -u
cd "$(dirname "$0")/.."

PLAN="/home/nicko/.claude/plans/ultracode-ultracode-dreamy-comet.md"
CLAUDE_PROJ="/home/nicko/.claude/projects/-mnt-c-Users-nikla-Documents-projects-2codeCC"
OUT="docs/nexusmind"
mkdir -p "$OUT/recovered"

# 1. Mirror the authoritative plan (the single most important recovery artifact).
if [ -f "$PLAN" ]; then
  cp "$PLAN" "$OUT/PLAN.md"
  echo "mirrored: PLAN.md"
else
  echo "WARN: plan file missing at $PLAN (PLAN.md mirror left as-is)"
fi

# 2. Recover every workflow agent result from the durable journals.
#    Renders each {"type":"result"} line to markdown, schema-agnostic.
python3 - "$CLAUDE_PROJ" "$OUT/recovered" << 'PYEOF'
import json, os, sys, glob

proj, outdir = sys.argv[1], sys.argv[2]

def render(obj, depth=2):
    lines = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            lines.append("#" * depth + " " + str(k))
            lines.extend(render(v, min(depth + 1, 6)))
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            if isinstance(item, dict):
                # Compact one-dict-per-section rendering keyed by a title-ish field
                title = item.get("topic") or item.get("title") or item.get("path") or str(i + 1)
                lines.append("#" * depth + " " + str(title))
                for k, v in item.items():
                    if v is None or str(v) == str(title):
                        continue
                    lines.append("**" + str(k) + ":** " + (str(v) if not isinstance(v, (dict, list)) else ""))
                    if isinstance(v, (dict, list)):
                        lines.extend(render(v, min(depth + 1, 6)))
            else:
                lines.append("- " + str(item))
    else:
        lines.append(str(obj))
    return lines

count = 0
for journal in sorted(glob.glob(os.path.join(proj, "*", "subagents", "workflows", "*", "journal.jsonl"))):
    wf = os.path.basename(os.path.dirname(journal))
    session = journal.split(os.sep)[-5] if "subagents" in journal else "unknown"
    session_prefix = session.split("-")[0][:8]
    n = 0
    with open(journal) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "result" or obj.get("result") in (None, {}):
                continue
            n += 1
            name = f"{session_prefix}-{wf}-result{n}.md"
            path = os.path.join(outdir, name)
            body = "\n".join(render(obj["result"]))
            header = f"# Recovered workflow result\n\nSession: {session}\nWorkflow: {wf}\nAgent: {obj.get('agentId','?')}\n\n"
            with open(path, "w") as out:
                out.write(header + body + "\n")
            count += 1
print(f"recovered: {count} workflow agent results")
PYEOF

# 2b. Agent roster + brief recovery: reconstruct WHICH agents existed, which
#     were plausibly mid-flight at a crash (fresh transcript mtime), and save
#     each agent's original spawn brief so it can be respawned verbatim.
#     Works POST-crash too — transcripts under ~/.claude are durable evidence.
python3 - "$CLAUDE_PROJ" "$OUT" << 'PYEOF'
import json, os, sys, glob, time

proj, outdir = sys.argv[1], sys.argv[2]
briefs = os.path.join(outdir, "recovered", "briefs")
os.makedirs(briefs, exist_ok=True)
now = time.time()

rows = []
for meta_path in glob.glob(os.path.join(proj, "*", "subagents", "agent-*.meta.json")):
    jsonl = meta_path[: -len(".meta.json")] + ".jsonl"
    try:
        meta = json.load(open(meta_path))
    except Exception:
        meta = {}
    session = meta_path.split(os.sep)[-3]
    name = meta.get("name") or "unnamed"
    desc = meta.get("description") or "?"
    hash8 = os.path.basename(meta_path).rsplit("-", 1)[-1][:8]
    mtime = os.path.getmtime(jsonl) if os.path.exists(jsonl) else 0
    age_min = (now - mtime) / 60 if mtime else None
    state = "ACTIVE?" if age_min is not None and age_min < 15 else "inactive"

    # Recover the original spawn brief (first user message in the transcript).
    brief_file = ""
    if os.path.exists(jsonl):
        try:
            with open(jsonl) as f:
                for line in f:
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if obj.get("type") != "user":
                        continue
                    content = (obj.get("message") or {}).get("content")
                    text = content if isinstance(content, str) else "\n".join(
                        b.get("text", "") for b in content if isinstance(b, dict)
                    ) if isinstance(content, list) else ""
                    if text.strip():
                        brief_file = f"{session.split('-')[0][:8]}-{name}-{hash8}.md"
                        with open(os.path.join(briefs, brief_file), "w") as bf:
                            bf.write(f"# Spawn brief: {name} ({desc})\n\nSession: {session}\nTranscript: {jsonl}\n\n---\n\n{text}\n")
                        break
        except Exception:
            pass
    rows.append((mtime, state, name, desc, session.split("-")[0][:8], jsonl, brief_file))

rows.sort(reverse=True)
with open(os.path.join(outdir, "AGENTS.md"), "w") as out:
    out.write("# Agent roster (regenerated by nexusmind-checkpoint.sh)\n\n")
    out.write("`ACTIVE?` = transcript modified <15 min before this scan — if the terminal\n")
    out.write("just died, these were mid-flight: assess their slice on disk, then respawn\n")
    out.write("using the recovered brief + a state delta (see STATUS.md playbook).\n\n")
    out.write("| state | agent | task | session | last activity | brief |\n|---|---|---|---|---|---|\n")
    for mtime, state, name, desc, sess, jsonl, brief in rows:
        ts = time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime)) if mtime else "?"
        blink = f"[brief](recovered/briefs/{brief})" if brief else "—"
        out.write(f"| {state} | {name} | {desc} | {sess} | {ts} | {blink} |\n")
    out.write("\nTranscripts (full context, resumable while the owning session lives):\n\n")
    for mtime, state, name, desc, sess, jsonl, brief in rows:
        out.write(f"- {name}: `{jsonl}`\n")
active = [r for r in rows if r[1] == "ACTIVE?"]
print(f"agent roster: {len(rows)} agents, {len(active)} plausibly active: " + ", ".join(r[2] for r in active))
PYEOF

# 3. Append a state snapshot so a fresh session can see WHEN the last
#    checkpoint ran and what the tree looked like.
{
  echo "=== checkpoint $(date '+%Y-%m-%d %H:%M:%S') ==="
  echo "git: $(git status --porcelain 2>/dev/null | wc -l) dirty paths, branch $(git branch --show-current 2>/dev/null)"
  echo "rust: $(ls src-tauri/src/knowledge/*.rs 2>/dev/null | wc -l) knowledge modules; bin: $(ls src-tauri/src/bin/made-knowledge-mcp/*.rs 2>/dev/null | wc -l) adapter modules"
  echo "frontend: $(ls src/components/knowledge/*.tsx 2>/dev/null | wc -l) knowledge components; lib: $(ls src/lib/knowledge/*.ts 2>/dev/null | wc -l) modules"
} >> "$OUT/CHECKPOINTS.log"
tail -5 "$OUT/CHECKPOINTS.log"
echo "harness done: docs/nexusmind/ is current (STATUS.md is hand-maintained — see it for resume instructions)"
