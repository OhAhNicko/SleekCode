---
name: end
description: Session wrap-up — verify work, write learnings, save session prompts
---

Session wrap-up workflow.

1. Verify work: best practices, efficiency, security, build/tests/lint pass
2. Check if anything needs to go into the plan file
3. Create learnings doc: `docs/learnings/YYYY-MM-DD-<short-title>.md`
   - Stamp the session directly under the H1 — see `/lesson` for the exact block and
     for where the id (scratchpad path) and name (`ai-title` record) come from:

     ```markdown
     **Session:** `<session-id>`
     **Name:** <session name>
     **Resume:** `claude --resume <session-id>`
     ```
   - Write it with the same depth and quality as `/lesson` — not a surface-level summary
   - If there were bugs or failed attempts, explain the faulty reasoning behind each attempt and why it failed
   - The goal is to prevent repeating the same mistakes — a one-liner like "three attempts failed" is useless; explain WHY they failed
   - Include: Summary, Symptoms, Root cause (with full debugging story if applicable), Fix, Prevention, Verification
4. If a major bug or important gotcha was discovered, save a concise one-liner to `MEMORY.md` to prevent repeating it
5. Append all USER prompts from this session to `docs/session-prompts.txt`
   - Format: numbered messages with date/session header
   - The block header carries the session stamp:

     ```
     ## YYYY-MM-DD — <topic>
     Session: <session-id> — "<session name>"
     Resume: claude --resume <session-id>
     ```
   - Only user messages, not Claude responses
6. Stamp any handoff / STATUS / next-session doc or `docs/superpowers/specs/*.md`
   written this session with the same block. Do NOT stamp rolling docs that many
   sessions co-own (`docs/architecture.md`, `tasks/todo.md`, `MEMORY.md`).
