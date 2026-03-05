---
name: end
description: Session wrap-up — verify work, write learnings, save session prompts
---

Session wrap-up workflow.

1. Verify work: best practices, efficiency, security, build/tests/lint pass
2. Check if anything needs to go into the plan file
3. Create learnings doc: `docs/learnings/YYYY-MM-DD-<short-title>.md`
   - Write it with the same depth and quality as `/lesson` — not a surface-level summary
   - If there were bugs or failed attempts, explain the faulty reasoning behind each attempt and why it failed
   - The goal is to prevent repeating the same mistakes — a one-liner like "three attempts failed" is useless; explain WHY they failed
   - Include: Summary, Symptoms, Root cause (with full debugging story if applicable), Fix, Prevention, Verification
4. If a major bug or important gotcha was discovered, save a concise one-liner to `MEMORY.md` to prevent repeating it
5. Append all USER prompts from this session to `docs/session-prompts.txt`
   - Format: numbered messages with date/session header
   - Only user messages, not Claude responses
