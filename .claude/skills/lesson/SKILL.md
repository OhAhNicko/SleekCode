---
name: lesson
description: Capture learnings from the current conversation into a markdown doc
---

Capture learnings from the current conversation in a markdown file.

1. File: `docs/learnings/YYYY-MM-DD-<short-title>.md`
2. Stamp the session directly under the H1, so a reader can reopen this conversation:

   ```markdown
   # <title>

   **Session:** `<session-id>`
   **Name:** <session name>
   **Resume:** `claude --resume <session-id>`
   ```

   - **id** — the directory segment in your scratchpad path:
     `/tmp/claude-<uid>/<project-slug>/<SESSION_ID>/scratchpad`. Never invent one,
     never copy an id out of another doc.
   - **name** — the last `ai-title` record in your own transcript:

     ```bash
     grep -o '"aiTitle":"[^"]*"' \
       ~/.claude/projects/-mnt-c-Users-nikla-Documents-projects-2codeCC/<SESSION_ID>.jsonl \
       | tail -1
     ```

     No `ai-title` yet (young session)? Omit the **Name:** line — don't guess one.
3. Include sections: Summary, Symptoms, Root cause, Fix, Prevention, Verification
4. If a major bug or important gotcha was discovered, save a concise one-liner to `MEMORY.md` to prevent repeating it
