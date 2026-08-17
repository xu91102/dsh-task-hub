---
name: manage-taskboard
description: How to work an issue on the task board — claim it, report progress, and hand it back. Use whenever you pick up, update, or finish a board issue, or want to propose new work.
---

# Working the task board

The board is shared with a human. These rules exist so your work is visible while
it happens and so nothing lands on the board that a human did not agree to.

## Claim before you work

1. `taskboard_get` the issue. Keep the `version` it returns.
2. `taskboard_update` it to `in_progress`, passing that `version`.

Passing the version is not a formality. If someone moved the issue while you were
reading it, the write is refused and you re-read instead of overwriting their
change.

## Report as you go

Put findings, blockers, and decisions in `taskboard_comment` on the issue — not
only in your own reasoning. The comment trail is what the human reads to decide
whether to accept the work, and it is what the next round inherits if the work
spans several agents.

If you get stuck, move the issue to `blocked` and comment why. A blocked issue
with a reason is useful; a silent one is not.

## Hand back, do not sign off

When the work is done, move the issue to `in_review` and comment what you did and
how you verified it.

**Do not move an issue to `done`.** The tool will refuse it, and it should:
finishing work and accepting work are two different acts, and the second one is
the human's. Wait for them to accept it, or to tell you what still needs doing.

**Do not move an issue to `archieved` either.** Archiving is shelving finished
work, and shelving is as much the human's call as accepting is. Leave `archieved`
alone; the human archives accepted work from the board.

## Proposing new work

When you find work worth doing that is not this issue, do not start it and do not
fold it into the current issue. Use `taskboard_propose`.

A proposal lands in the `proposed` column and does nothing until a human approves
it. That is the point — you can surface everything you noticed without any of it
silently becoming committed work.

Write proposals a human can decide on in a few seconds:

- a title that says what changes, not what is wrong
- a description with why it matters and what "done" would mean
- one issue per proposal, so they can accept some and reject others

Do not propose the task you are already doing, and do not re-propose something
already on the board — `taskboard_list` first.

## When the board and the conversation disagree

The board is the durable record; the conversation is not. If the human asks for
something that contradicts an issue, follow the human and comment on the issue so
the record catches up.
