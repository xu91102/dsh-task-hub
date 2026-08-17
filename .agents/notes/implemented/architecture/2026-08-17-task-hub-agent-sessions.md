# Agent Note: Task Hub agent sessions

Status: implemented

## Problem

Task Hub needs durable user-created agent identities while DeepSeek Harness owns model selection, tools, prompt sections, skills, session logs, and execution. Treating either identity as the other would persist deployment details in the board or create sessions without the selected runtime.

Task review notifications also outlive the task's `in_review` status. Removing a notification when a user accepts or sends back the task prevents the same action from recording read and archive state.

## Decision

`AgentProfile` stores the user's stable display identity, instructions, concurrency, visibility, and selected Harness preset id. The service validates deployment-varying numbers and enum values before persistence because HTTP callers reach it through raw JSON. Every task execution creates a separate persistent Harness session. Session creation resolves the current model and selected preset before publishing the agent, installs the complete model selection, mounts the preset during unpublished setup, and rejects missing or invalid references without publishing a session.

Builder sessions use the same creation path. Their session-scoped tools persist a profile or task only after the user confirms the proposed configuration. The initial user message, tool call, and tool result remain in the Harness session log.

Review inbox events are projected from append-only task status activity. The activity id is the event identity, while the activity row records the execution id that entered review. Accepting, sending back, or reviewing the same execution again therefore does not remove or overwrite an event. Read and archive receipts remain separate durable state.

The browser plugin opens Task Hub as Harness conversation views. The package's postinstall patches only add host extension slots and navigation metadata that the released host packages do not expose. Opening an execution first selects its exact Harness session and then selects the `chat` conversation view.

## Alternatives considered

**Persist complete runtime configuration in `AgentProfile`.** This duplicates Harness preset composition and becomes stale when a preset changes. The profile therefore stores only the preset id and resolves it for each new session.

**Create a session and report preset or model errors later.** This publishes a conversation that cannot assemble or execute. Resolution and mounting stay inside the unpublished agent creation sequence, and failures roll back before the session becomes visible.

**Derive review events only from current task status.** Acceptance and send-back remove `in_review`, so the event disappears before its receipt can be updated. Append-only status activity preserves the event without duplicating its content in a second storage format.

**Replace host client packages.** Forking the complete clients would make this plugin own unrelated UI behavior. The small patch scripts add only the extension points Task Hub consumes and fail when their expected upstream anchors change.

## Consequences

Deleting or breaking a selected preset blocks new Task Hub sessions immediately while existing sessions retain the composition they started with. User profiles remain durable and editable independently from session history.

Inbox history can contain more than one review event for a task whenever it enters review more than once. Each event has an independent receipt and keeps the execution session associated with that transition.

Host client upgrades require running the patch contract tests before installation. The package verifies session creation, preset failure rollback, task and agent builders, durable inbox events, exact session navigation, and the assembled browser flow. A runnable keyless example drives the Builder through the concrete agent loop and records its model-visible prompt, mounted preset, tool schema, tool result, and final response.
