# /end — Session wrap-up

## 1) Verify Work
Go back and verify all your work so far:
- Best coding practices followed
- Efficient implementation
- Security maintained (no secrets, safe patterns)
- Build passes, tests pass, lint has no errors

## 2) Plan Check
Check if anything discussed in this session needs to go back into the plan file.

## 3) Create Learnings Doc
Create a learnings markdown file capturing what was done/learned this session:

**File**: `docs/learnings/YYYY-MM-DD-<short-title>.md`

**Required sections**:
- **Summary**: What was accomplished
- **Symptoms**: Problems encountered (if any)
- **Root cause**: Why issues occurred
- **Fix**: How they were resolved
- **Prevention**: How to avoid in future
- **Verification**: Commands to verify the work

If the session was straightforward with no issues, the Symptoms/Root cause/Fix sections can be brief or combined into a "Notes" section.

## 4) Save Session Prompts
Append all USER prompts/messages from this session to `docs/session-prompts.txt`.

**Format**:
```
================================================================================
DATE: YYYY-MM-DD
SESSION: <brief session description or ID>
================================================================================

[1] <first user message>

[2] <second user message>

[3] <third user message>

... (continue for all user messages)

```

**Rules**:
- Only include the user's messages, not Claude's responses
- Number each message sequentially within the session
- Add a blank line between messages for readability
- If the file doesn't exist, create it with a header: `# Session Prompts Log`
- Append to the file (don't overwrite previous sessions)
