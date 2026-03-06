# Rename Task — Feature Plan

## Data model recap

A **task** is `{ id, name, sessions[] }`. Each **session** is a time entry `{ start, end }`. Sessions have no name of their own — they inherit meaning from the task they belong to.

So "renaming one entry" means: detach a session from its current task and attach it to a different (or new) one. "Renaming every entry" means: change `task.name` in place.

---

## Core UX tension: start session vs rename

Clicking a task already means "start a session." Rename must not break that — it needs a distinct, deliberate gesture. The solution follows the spirit of **Notational Velocity**: the search box is the command center for everything.

### Keyboard (NV-aligned)

The search box doubles as the rename field. No new UI element or mode is introduced.

1. Type a task name → it appears filtered and highlighted in the list.
2. Press **ArrowDown** to select the task (`selIdx >= 0`).
3. Edit the text in the search box to the desired new name.
4. Press **Shift+Enter** → rename the highlighted task to the current search box text.
5. Press **Enter** alone → start a session as usual.
6. Press **Escape** → cancel (clears search box, resets state).

This means the only new thing a user learns is **Shift+Enter = rename**. Everything else is existing behavior. The modifier key is the disambiguation.

If the search box text already matches the task name when Shift+Enter is pressed (the user hasn't changed it), do nothing — treat it as a cancel.

### Mouse

**Double-click** on the task name (`.t-name`) → the name becomes an inline `<input>` field, pre-filled with the current name, in place on the task row. This is the same pattern used for editing session times (click-to-edit), and the same pattern used by every file manager for renaming files.

- Single click anywhere on `.task-main` → start session (unchanged).
- Double-click specifically on `.t-name` → rename inline.
- Press **Enter** or blur the input → confirm.
- Press **Escape** → cancel, restore original name.

These two gestures (single vs double click) are unambiguous and familiar.

---

## Two rename surfaces

| Surface | Trigger (mouse) | Trigger (keyboard) | Disambiguation needed? | Result |
|---|---|---|---|---|
| Task header (`.t-name`) | Double-click | Shift+Enter with task selected | No | Rename `task.name` for all sessions |
| Session row in history | Double-click the task name label on the session row | — | Yes (rename all vs move this session) | Move that session to a new/existing task |

For session-level rename, the trigger is a double-click on the task name label shown on a session row in the **history view** (where it's visible and relevant). In the today view, sessions are already nested under their task row so the context is clear — no rename surface is needed there.

After double-clicking a session's task name label, a small inline prompt appears below the input:

```
Move to: [__________]
  ● Move this session only
  ○ Rename all sessions of this task
[Confirm]  [Cancel]
```

Keyboard navigation within this prompt: **Tab** between the radio options, **Enter** to confirm, **Escape** to cancel.

---

## Name collisions

### Rename all → collision

User renames "React Query" to "Deep Work", which already exists.

Instead of blocking, show a confirmation inline:

> **"Deep Work" already exists. Merge all React Query sessions into it?**
> [Merge]  [Cancel]

If confirmed: all sessions from "React Query" are appended to "Deep Work", then "React Query" is deleted. Sessions sort naturally by `start` timestamp, so order is preserved without extra work.

If cancelled: the rename input remains open so the user can try a different name.

### Move session → collision

User moves one session to a name that already exists. No prompt — the intent is explicit. The session is silently appended to the existing task's `sessions` array.

---

## Edge cases

**1. Moving a session leaves the original task empty**
If a task had only one session and the user moves it, the task becomes `{ id, name, sessions: [] }`.
→ **Delete the now-empty task automatically.** An empty task has no meaning.

**2. Renaming/moving the currently running session**
The running session has `end: null`. Moving it mid-run is risky.
→ **Disallow moving a live session.** Hide the "Move this session only" option when the session is running. Renaming all (changing `task.name`) is still allowed — it's safe regardless of run state.

**3. Empty name**
User clears the input and confirms (Enter or blur).
→ **Cancel silently** — treat empty input as an abort. Do not delete the task.

**4. Shift+Enter with no task selected (`selIdx < 0`)**
→ Do nothing. Fall through to normal Enter behavior (start or create task).

**5. Undo**
There is no undo system. Confirm steps (Shift+Enter, [Merge] button) are deliberate enough to prevent accidents. Do not add undo for now.

**6. Session ordering after a move**
Sessions are rendered sorted by `start` timestamp. After a move, the session slots into the correct chronological position naturally — no explicit sort step needed.

**7. Double-click on a task that is currently running**
The running task has an active session. Renaming it is safe — only `task.name` changes, sessions are untouched.
→ Allow rename normally.

---

## Summary of new logic

- `renameTask(taskId, newName)` — changes `task.name`. If `newName` matches an existing task, show merge confirmation. On merge: move all sessions, delete source task.
- `moveSession(taskId, sessionStart, newName)` — finds or creates a task with `newName`, moves the session object, deletes the source task if it becomes empty.
- No backend changes needed — both operations mutate the in-memory `data.tasks` array and call the existing `persist()`.
