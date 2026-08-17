/**
 * The board's stylesheet — layout only.
 *
 * Every colour is a `--dsw-alias-*` token, so the board follows whatever theme
 * the harness is in and keeps following it when the user switches. Nothing here
 * defines a colour value of its own; the original board shipped 240KB of CSS,
 * and almost all of it was re-stating things the host already knows.
 *
 * There is no bundler in this package's build (see docs/spike-findings.md), so
 * the sheet is a string injected at mount rather than a CSS import.
 * @module dsh-task-hub/client/styles
 */

/** Stylesheet text, injected once per page by {@link installStyles}. */
const CSS = `
/* The composer floats over the bottom of the session body (the chat view lives
   with the same thing), so the board reserves room for it rather than letting
   its last cards sit under it. */
.tb-root {
  box-sizing: border-box; display: flex; flex-direction: column;
  height: 100%; min-height: 0; overflow: hidden; color: var(--dsw-alias-label-primary);
}
.tb-board-head {
  flex: none; min-height: 56px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.tb-board-title { display: flex; align-items: center; gap: 9px; }
.tb-board-title h1 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 650; }
.tb-board-title > span:last-child { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-board-title-icon { color: var(--dsw-alias-label-secondary); font-size: 18px; transform: rotate(180deg); }
.tb-board-toolbar {
  flex: none; display: flex; align-items: center; gap: 8px; min-height: 52px;
  padding: 8px 18px; box-sizing: border-box; flex-wrap: wrap;
}
.tb-board-scopes, .tb-board-projects { display: flex; align-items: center; gap: 6px; }
.tb-board-projects { min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tb-board-projects::-webkit-scrollbar { display: none; }
.tb-bar-end { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.tb-waiting { font-size: 12px; font-weight: 500; color: var(--dsw-alias-state-warn-primary); }
.tb-agent-working {
  min-height: 28px; display: inline-flex; align-items: center; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap;
}
.tb-error {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-secondary);
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px; padding: 6px 10px;
}

/* Scheduler row: the one thing on the board that RUNS work, so it reads like
   a control strip, not a status line. */
.tb-sched {
  flex: none; display: flex; align-items: center; gap: 12px; min-height: 36px;
  padding: 0 18px 8px; font-size: 12px;
}
.tb-toggle {
  font-size: 12px; height: 24px; padding: 0 10px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  transition: color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-toggle:not([data-on]):hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
}
.tb-toggle[data-on] {
  color: var(--dsw-alias-brand-primary-invert);
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.tb-sched-field { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.tb-sched-field input {
  box-sizing: border-box; width: 48px; height: 24px; padding: 0 6px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
}
.tb-sched-state { color: var(--dsw-alias-label-secondary); }

.tb-columns {
  flex: 1; min-height: 0; display: flex; gap: 12px; align-items: stretch;
  overflow: auto; padding: 0 18px 220px;
}
.tb-column {
  flex: 0 0 280px; min-height: 420px; display: flex; flex-direction: column;
  gap: 10px; padding: 10px; box-sizing: border-box;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 62%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent);
}
.tb-column[data-status='in_progress'] { background: color-mix(in srgb, var(--dsw-alias-state-warn-secondary) 22%, var(--dsw-alias-bg-base)); }
.tb-column[data-status='in_review'] { background: color-mix(in srgb, var(--dsw-alias-state-success-secondary) 22%, var(--dsw-alias-bg-base)); }
.tb-column[data-status='done'], .tb-column[data-status='archieved'] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 6%, var(--dsw-alias-bg-base)); }
.tb-column[data-status='blocked'], .tb-column[data-status='failed'] { background: color-mix(in srgb, var(--dsw-alias-state-error-secondary) 18%, var(--dsw-alias-bg-base)); }
.tb-column-head {
  min-height: 30px; display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 0; padding: 0 2px;
  font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.tb-column-title { display: flex; align-items: center; gap: 7px; }
.tb-status-dot, .tb-task-status-dot { width: 9px; height: 9px; flex: none; box-sizing: border-box; border-radius: 50%; border: 1.5px solid var(--dsw-alias-label-tertiary); }
.tb-status-dot[data-status='in_progress'], .tb-task-status-dot[data-status='in_progress'] { border-color: var(--dsw-alias-state-warn-primary); }
.tb-status-dot[data-status='in_review'], .tb-task-status-dot[data-status='in_review'] { border-color: var(--dsw-alias-state-success-primary); }
.tb-status-dot[data-status='done'], .tb-task-status-dot[data-status='done'] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); }
.tb-status-dot[data-status='blocked'], .tb-status-dot[data-status='failed'] { border-color: var(--dsw-alias-state-error-primary); }
.tb-column-add {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.tb-column-add:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.tb-count { color: var(--dsw-alias-label-secondary); opacity: 0.6; font-weight: 400; }
/* The approval queue is the one column that should catch the eye. */
.tb-column[data-status="proposed"] .tb-column-head { color: var(--dsw-alias-state-warn-primary); }

.tb-card {
  display: flex; flex-direction: column; gap: 8px; padding: 12px 13px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-card:not([data-expanded]):hover {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
}
.tb-card[data-expanded] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.tb-card-title {
  text-align: left; background: none; border: 0; padding: 0; cursor: pointer;
  font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary);
}
.tb-card-kicker { display: flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.tb-card-priority-icon { color: var(--dsw-alias-label-tertiary); }
.tb-card-priority-icon[data-priority='urgent'], .tb-card-priority-icon[data-priority='high'] { color: var(--dsw-alias-state-warn-primary); }
.tb-card-preview {
  display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  margin: -1px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px;
}
.tb-card-project {
  align-self: flex-start; max-width: 100%; display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 7px; box-sizing: border-box; border-radius: 999px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tb-card-title:hover { color: var(--dsw-alias-brand-primary); }
.tb-priority { color: var(--dsw-alias-state-warn-primary); margin-right: 4px; }

/* Card meta line: runs, schedule badge, relative time. */
.tb-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tb-time { margin-left: auto; white-space: nowrap; }
.tb-runs { font-weight: 500; }
.tb-runs[data-result="failed"] { color: var(--dsw-alias-state-error-primary); }
.tb-runs[data-result="succeeded"] { color: var(--dsw-alias-state-success-primary); }
.tb-sched-badge {
  padding: 2px 8px; border-radius: 999px;
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.tb-session-chip {
  align-self: flex-start; font-size: 11px; padding: 2px 8px; cursor: pointer;
  color: var(--dsw-alias-brand-primary); background: none;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-session-chip:hover {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* Board header search box. */
.tb-search {
  box-sizing: border-box; flex: 0 1 230px; min-width: 160px; height: 30px;
  padding: 0 10px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-search:focus, .tb-search:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
}

.tb-decide { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.tb-proposer { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tb-reason {
  box-sizing: border-box; flex: 1; min-width: 120px; height: 26px; padding: 0 8px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-reason:focus, .tb-reason:focus-visible {
  outline: none; border-color: var(--dsw-alias-brand-primary);
}
.tb-detail {
  display: flex; flex-direction: column; gap: 8px; font-size: 12px;
  padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2);
}
.tb-comment { border-left: 2px solid var(--dsw-alias-border-l2); padding: 2px 0 2px 8px; }
.tb-comment-author { color: var(--dsw-alias-label-secondary); }
.tb-activity { margin: 0; padding-left: 16px; color: var(--dsw-alias-label-secondary); }

/* Execution history and schedule editor inside the expanded card. */
.tb-executions { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.tb-executions li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tb-exec-badge {
  font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
}
.tb-exec-badge[data-result="failed"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.tb-exec-badge[data-result="succeeded"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.tb-exec-times { color: var(--dsw-alias-label-secondary); }
.tb-exec-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; }
.tb-link {
  font-size: 11px; background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--dsw-alias-brand-primary);
}
.tb-link:hover { text-decoration: underline; }
.tb-schedule { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.tb-schedule-toggle { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.tb-cron { flex: 0 1 110px; min-width: 90px; }
.tb-preset {
  box-sizing: border-box; height: 26px; font-size: 11px; padding: 0 4px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.tb-preset:hover { border-color: var(--dsw-alias-border-l2); }
.tb-column-empty { display: grid; place-items: center; flex: 1; min-height: 130px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.tb-empty { font-size: 13px; color: var(--dsw-alias-label-secondary); text-align: center; padding: 40px 18px; }

/* Session mail: inter-session agent messages shown on the cards involved. */
.tb-msg-badge {
  display: inline-flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 500;
  padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.tb-msgs { display: flex; flex-direction: column; gap: 8px; }
.tb-msgs-head {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary);
}
.tb-msg {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  font-size: 12px;
}
/* A message the target session has not received yet: dashed, so "pending" reads
   even without the chip. */
.tb-msg[data-pending] { border-style: dashed; }
.tb-msg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tb-msg-dir { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.tb-msg-pending {
  font-size: 10px; font-weight: 500; padding: 0 6px; border-radius: 999px;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
}
.tb-msg-time { font-size: 11px; color: var(--dsw-alias-label-secondary); }

/* New-taskboard "+" in the board's project-pill bar. */
.tb-new-project {
  box-sizing: border-box; flex: none; width: 24px; height: 24px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  color: var(--dsw-alias-label-secondary);
  background: none; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px;
  transition: color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-new-project:hover {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}

/* Sidebar: the "New taskboard" button below New Session — same visual recipe
   as the shell's New Session button so the column reads as one control stack. */
.tb-side-new {
  box-sizing: border-box; width: 100%; height: 38px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  border-radius: 12px; flex: none;
  justify-content: center; align-items: center; gap: 6px;
  margin: 0 0 8px; padding: 8px 16px;
  font-size: 14px; font-weight: 500; line-height: 22px;
  display: flex; overflow: hidden;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-side-new:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.tb-side-new-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Rail form: one centred icon button, matching the shell's icon controls. */
.tb-side-new-rail { width: 36px; height: 36px; margin: 0 0 12px; padding: 0; border: none; border-radius: 50%; background: none; }
.tb-side-new-rail:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* Sidebar navigation follows Multica's two groups: personal navigation below
   New Task, then product areas below the host's Workspace heading. */
.tb-side-entry {
  box-sizing: border-box; width: 100%; height: 34px; cursor: pointer;
  display: flex; align-items: center; gap: 6px; padding: 0 8px;
  color: var(--dsw-alias-label-primary);
  background: none; border: none; border-radius: 8px;
  font-size: 14px; line-height: 20px;
}
.tb-side-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tb-side-entry[data-active] { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.tb-side-entry-rail { width: 36px; padding: 0; justify-content: center; }
.tb-side-nav-personal .tb-side-entry-rail { margin-left: -10px; }
.tb-side-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-side-nav { display: flex; flex-direction: column; gap: 2px; width: 100%; }
.tb-side-nav-personal { flex: none; margin-bottom: 8px; }
.tb-side-nav-workspace { flex: none; margin-bottom: 6px; }

/* Create-project modal content. */
.tb-create-form { display: flex; flex-direction: column; gap: 10px; }
.tb-modal-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
}
.tb-modal-footer .tb-error { flex: 1; }

/* Multica-shaped task composer. Modal owns focus trapping/mask; this headless
   card owns the hierarchy because its breadcrumb and footer differ from the
   host's generic form dialog. */
.tb-task-create-dialog {
  width: min(660px, calc(100vw - 32px)); max-width: none; max-height: min(720px, calc(100vh - 32px));
  padding: 0; overflow: hidden; border-radius: 16px;
  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 0 20px 64px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
}
.tb-task-create-shell { display: flex; flex-direction: column; min-height: 500px; max-height: inherit; }
.tb-task-create-head {
  flex: none; min-height: 54px; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 0 18px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.tb-task-create-breadcrumb { min-width: 0; display: flex; align-items: center; gap: 7px; font-size: 13px; }
.tb-task-create-breadcrumb > span:first-child { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.tb-task-create-breadcrumb > span:nth-child(2) { color: var(--dsw-alias-label-tertiary); }
.tb-task-create-breadcrumb strong { font-weight: 650; white-space: nowrap; }
.tb-task-create-close, .tb-task-icon-button {
  width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.tb-task-create-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.tb-task-icon-button:disabled { cursor: not-allowed; opacity: .42; }
.tb-task-create-main {
  flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 15px;
  padding: 20px 22px 18px; overflow-y: auto;
}
.tb-task-title-field, .tb-task-description-field {
  box-sizing: border-box; width: 100%; padding: 0; font: inherit;
  color: var(--dsw-alias-label-primary); background: transparent; border: 0; outline: none;
}
.tb-task-title-field { height: 42px; font-size: 22px; font-weight: 650; line-height: 32px; }
.tb-task-title-field::placeholder, .tb-task-description-field::placeholder { color: var(--dsw-alias-label-tertiary); }
.tb-task-description-field { min-height: 156px; resize: none; font-size: 14px; line-height: 22px; }
.tb-task-title-field:focus-visible, .tb-task-description-field:focus-visible {
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);
}
.tb-task-agent-prompt { display: flex; flex-direction: column; gap: 14px; min-height: 210px; }
.tb-task-agent-label { display: flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-task-agent-label svg { color: var(--dsw-alias-brand-primary); }
.tb-task-derived-title {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: baseline;
  padding: 10px 12px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); font-size: 12px;
}
.tb-task-derived-title span { color: var(--dsw-alias-label-secondary); }
.tb-task-derived-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-task-creator-note { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-task-avatar {
  width: 24px; height: 24px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 11%, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-brand-primary); font-size: 10px; font-weight: 650;
}
.tb-task-properties { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.tb-task-property {
  min-height: 30px; max-width: 220px; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  padding: 0 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); font-size: 12px;
}
.tb-task-property select {
  min-width: 0; max-width: 150px; appearance: none; padding: 0 12px 0 0; border: 0; outline: 0;
  color: var(--dsw-alias-label-primary); background: transparent; font: inherit; cursor: pointer;
}
.tb-task-project-property > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-task-create-footer {
  flex: none; min-height: 62px; box-sizing: border-box; display: flex; align-items: center; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
}
.tb-task-mode-switch {
  display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 9px;
  border: 0; border-radius: 8px; color: var(--dsw-alias-label-secondary); background: transparent;
  font: inherit; font-size: 12px; cursor: pointer;
}
.tb-task-mode-switch:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.tb-task-mode-switch svg { color: var(--dsw-alias-brand-primary); }
.tb-task-keep-open { margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }
.tb-task-keep-open input { accent-color: var(--dsw-alias-brand-primary); }
.tb-task-create-footer > button:last-child { margin-left: auto; }

/* Drag & drop: the card title is the drag handle; columns are the targets.
   The highlight is an inset dashed ring on the column, and the dragged card
   ghosts itself at half strength so what will land where stays readable. */
.tb-card { cursor: grab; }
.tb-card:not([data-expanded]) { touch-action: none; user-select: none; }
.tb-card:active { cursor: grabbing; }
.tb-card button, .tb-card input, .tb-card textarea, .tb-card select { cursor: auto; }
.tb-card-title { cursor: grab; }
.tb-card-title:active { cursor: grabbing; }
.tb-card[data-dragging] { opacity: 0.5; }
.tb-card[data-dragging] .tb-card-title { cursor: grabbing; }
.tb-column {
  border-radius: 12px;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-column.tb-column-over {
  background: var(--dsw-alias-interactive-bg-hover);
  box-shadow: inset 0 0 0 1.5px dashed var(--dsw-alias-brand-primary);
}
.tb-column-drop-hint {
  border: 1.5px dashed var(--dsw-alias-border-l2); border-radius: 10px;
  padding: 14px 8px; font-size: 12px; text-align: center;
  color: var(--dsw-alias-label-secondary);
}

/* Card head: title + edit pencil, so "edit" is one click without opening the
   detail. The pencil is a hover affordance like the card's own border. */
.tb-card-head { display: flex; align-items: flex-start; gap: 6px; }
.tb-card-head .tb-card-title { flex: 1; min-width: 0; }
.tb-card-edit {
  flex: 0 0 auto; width: 20px; height: 20px; padding: 0; font-size: 12px; line-height: 1;
  cursor: pointer; color: var(--dsw-alias-label-secondary);
  background: none; border: 1px solid transparent; border-radius: 6px;
  opacity: 0;
  transition: opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-card:hover .tb-card-edit, .tb-card-edit:focus-visible { opacity: 1; }
.tb-card-edit:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-l2); }
.tb-card-edit-on { opacity: 1; }

/* Inline title editor, styled like the other board text fields. */
.tb-title-input {
  box-sizing: border-box; flex: 1; min-width: 0; height: 26px; padding: 0 8px;
  font-size: 13px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-title-input:focus, .tb-title-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }

/* Description row and its editor. */
.tb-desc { display: flex; align-items: flex-start; gap: 6px; }
.tb-desc > :first-child { flex: 1; min-width: 0; }
.tb-desc-empty { color: var(--dsw-alias-label-secondary); font-style: italic; }
.tb-desc-input {
  box-sizing: border-box; width: 100%; min-height: 72px; padding: 8px; resize: vertical;
  font: inherit; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-desc-input:focus, .tb-desc-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }

/* Priority + labels edit row. */
.tb-fields { display: flex; flex-direction: column; gap: 8px; }
.tb-field { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.tb-field-label { color: var(--dsw-alias-label-secondary); }
.tb-label-pill {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px;
  font-size: 11px; border-radius: 999px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.tb-label-x {
  width: 14px; height: 14px; padding: 0; font-size: 11px; line-height: 1; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: none; border: 0; border-radius: 50%;
}
.tb-label-x:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }
.tb-label-add {
  box-sizing: border-box; flex: 1; min-width: 90px; height: 24px; padding: 0 10px; font-size: 11px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-label-add:focus, .tb-label-add:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }

/* Shared Task Hub surface. */
.tb-hub-page {
  box-sizing: border-box; display: flex; flex-direction: column; min-height: 100%;
  padding: 0 0 220px; color: var(--dsw-alias-label-primary);
}
.tb-page-head {
  position: sticky; top: 0; z-index: 4; min-height: 56px; box-sizing: border-box;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 18px; background: var(--dsw-alias-bg-base);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.tb-page-actions { display: flex; align-items: center; gap: 8px; }
.tb-back {
  border: 0; background: none; padding: 6px 8px; border-radius: 7px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font: inherit;
}
.tb-back:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.tb-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 18px; }
.tb-hub-search {
  box-sizing: border-box; width: 310px; height: 34px; padding: 0 12px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px;
}
.tb-filter-chip {
  min-height: 30px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.tb-filter-chip[data-active] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 600; }

/* User-created agent roster, creation flow, and detail workspace. */
.tb-agent-page { padding-bottom: 80px; }
.tb-agent-page-head { position: static; }
.tb-agent-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tb-agent-title > strong { font-size: 16px; }
.tb-agent-title > span { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-agent-title > small { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-left: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb-agent-toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 18px; }
.tb-agent-scopes { display: flex; align-items: center; gap: 6px; }
.tb-agent-sort { display: flex; align-items: center; gap: 7px; margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-agent-sort select, .tb-config-field select, .tb-config-field textarea, .tb-config-field input {
  box-sizing: border-box; min-height: 34px; padding: 7px 10px; font: inherit;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.tb-agent-table { display: flex; flex-direction: column; padding: 0 18px; }
.tb-agent-row {
  display: grid; grid-template-columns: minmax(210px, 1.65fr) 1fr minmax(120px, .85fr) .78fr minmax(130px, 1fr) .9fr .55fr;
  align-items: center; min-height: 72px; gap: 14px; padding: 8px 12px;
  border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: transparent; color: var(--dsw-alias-label-secondary); text-align: left; cursor: pointer;
}
button.tb-agent-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tb-agent-row-head { min-height: 38px; font-size: 12px; cursor: default; }
.tb-agent-name, .tb-inbox-agent, .tb-owner-cell { display: flex; align-items: center; gap: 10px; color: var(--dsw-alias-label-primary); }
.tb-agent-name > span:last-child, .tb-inbox-agent > span:last-child { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.tb-agent-name strong, .tb-agent-name small, .tb-runtime-cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb-agent-name small, .tb-inbox-agent small, .tb-work-row small { color: var(--dsw-alias-label-secondary); }
.tb-avatar {
  position: relative; flex: 0 0 auto; width: 36px; height: 36px; border-radius: 50%; display: inline-flex;
  align-items: center; justify-content: center; font-weight: 700;
  color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-2));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, var(--dsw-alias-border-l1));
}
.tb-avatar[data-agent='0'], .tb-avatar[data-agent='3'], .tb-avatar[data-agent='6'], .tb-avatar[data-agent='9'] { color: #8b5cf6; background: color-mix(in srgb, #8b5cf6 10%, var(--dsw-alias-bg-layer-2)); }
.tb-avatar[data-agent='1'], .tb-avatar[data-agent='4'], .tb-avatar[data-agent='7'] { color: #0f9f6e; background: color-mix(in srgb, #0f9f6e 10%, var(--dsw-alias-bg-layer-2)); }
.tb-avatar > i { position: absolute; right: -1px; bottom: -1px; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); border: 2px solid var(--dsw-alias-bg-base); }
.tb-avatar > i[data-online] { background: var(--dsw-alias-state-success-primary); }
.tb-avatar-lg { width: 52px; height: 52px; font-size: 20px; }
.tb-avatar-xl { width: 64px; height: 64px; font-size: 24px; }
.tb-owner-avatar { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 10px; font-weight: 700; }
.tb-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.tb-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.tb-status[data-online] { color: var(--dsw-alias-state-success-primary); }
.tb-status[data-online]::before { background: var(--dsw-alias-state-success-primary); }
.tb-agent-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 80px 20px; text-align: center; }
.tb-agent-empty p { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); }

.tb-agent-create-page { min-height: 100%; padding-bottom: 80px; }
.tb-create-method, .tb-builder-setup { width: min(860px, calc(100% - 40px)); margin: 0 auto; padding: 74px 0 40px; }
.tb-create-heading { text-align: center; margin-bottom: 34px; }
.tb-create-heading h1 { margin: 8px 0 10px; font-size: clamp(26px, 4vw, 36px); letter-spacing: -.025em; }
.tb-create-heading p { margin: 0; color: var(--dsw-alias-label-secondary); }
.tb-eyebrow { color: var(--dsw-alias-brand-primary); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.tb-create-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.tb-create-card { position: relative; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 16px; min-height: 154px; padding: 24px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
.tb-create-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l1)); box-shadow: 0 12px 30px rgba(0,0,0,.08); }
.tb-create-card > span:nth-of-type(2) { display: flex; flex-direction: column; gap: 7px; }
.tb-create-card strong { font-size: 16px; }
.tb-create-card small { color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.tb-create-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 12px; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-2)); font-size: 20px; }
.tb-create-card-featured { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, var(--dsw-alias-border-l1)); }
.tb-create-badge { position: absolute; right: 14px; top: 12px; padding: 3px 7px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-brand-primary); font-size: 10px; font-weight: 700; }
.tb-builder-setup { width: min(660px, calc(100% - 40px)); }
.tb-builder-note { padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.tb-builder-note p { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.tb-agent-config { width: min(840px, calc(100% - 40px)); margin: 0 auto; padding: 44px 0; }
.tb-config-heading { text-align: left; margin-bottom: 28px; }
.tb-config-heading h1 { font-size: 28px; }
.tb-config-stack { display: flex; flex-direction: column; gap: 16px; }
.tb-config-section { display: flex; flex-direction: column; gap: 18px; padding: 22px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); }
.tb-config-section-title { display: flex; align-items: flex-start; gap: 12px; }
.tb-config-section-title > span { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-2)); font-size: 11px; font-weight: 700; }
.tb-config-section-title > div { display: flex; flex-direction: column; gap: 4px; }
.tb-config-section-title small { color: var(--dsw-alias-label-secondary); }
.tb-agent-identity-editor { display: grid; grid-template-columns: auto 1fr; align-items: start; gap: 18px; }
.tb-config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; width: 100%; }
.tb-config-field { display: flex; flex-direction: column; gap: 7px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-config-field textarea { width: 100%; min-height: 150px; resize: vertical; line-height: 1.55; }
.tb-config-field input { width: 100%; }
.tb-permission-options { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.tb-permission-card { display: flex; align-items: flex-start; gap: 11px; padding: 15px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; }
.tb-permission-card[data-active] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-1)); }
.tb-permission-card > span:last-child { display: flex; flex-direction: column; gap: 5px; }
.tb-permission-card small { color: var(--dsw-alias-label-secondary); line-height: 1.45; }

.tb-agent-detail { display: flex; flex-direction: column; gap: 20px; padding: 30px 28px 80px; max-width: 1180px; width: 100%; box-sizing: border-box; margin: 0 auto; }
.tb-agent-hero { display: flex; align-items: center; gap: 16px; padding: 6px 0 2px; }
.tb-agent-hero-copy { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.tb-agent-hero-copy > div { display: flex; align-items: center; gap: 10px; }
.tb-agent-hero h1, .tb-inbox-detail h1 { margin: 0; font-size: 23px; }
.tb-agent-hero p { margin: 0; color: var(--dsw-alias-label-secondary); }
.tb-agent-hero small { color: var(--dsw-alias-label-tertiary); }
.tb-agent-hero-actions { display: flex; gap: 8px; margin-left: auto; }
.tb-detail-tabs, .tb-subtabs { display: flex; align-items: center; gap: 22px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.tb-detail-tabs button, .tb-subtabs button { position: relative; min-height: 39px; padding: 0 2px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.tb-detail-tabs button[data-active], .tb-subtabs button[data-active] { color: var(--dsw-alias-label-primary); font-weight: 650; }
.tb-detail-tabs button[data-active]::after, .tb-subtabs button[data-active]::after { content: ''; position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; background: var(--dsw-alias-brand-primary); }
.tb-agent-overview { display: grid; grid-template-columns: minmax(0, 2fr) minmax(250px, .9fr); gap: 16px; }
.tb-agent-main-column, .tb-agent-side-column { display: flex; flex-direction: column; gap: 16px; }
.tb-panel { padding: 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.tb-panel h2, .tb-task-inspector h2 { margin: 0; font-size: 14px; }
.tb-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 13px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.tb-panel-heading > div p { margin: 5px 0 0; color: var(--dsw-alias-label-secondary); }
.tb-prewrap { white-space: pre-wrap; line-height: 1.65; }
.tb-profile-card dl, .tb-task-inspector dl { display: grid; grid-template-columns: auto 1fr; gap: 11px 14px; margin: 14px 0 0; font-size: 12px; }
.tb-profile-card dt, .tb-task-inspector dt { color: var(--dsw-alias-label-secondary); }
.tb-profile-card dd, .tb-task-inspector dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.tb-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
.tb-stat-grid > span { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.tb-stat-grid strong { font-size: 18px; }
.tb-stat-grid small { color: var(--dsw-alias-label-secondary); }
.tb-agent-work-list { display: flex; flex-direction: column; }
.tb-agent-work-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 11px; min-height: 54px; border-top: 1px solid var(--dsw-alias-border-l1); }
.tb-agent-work-row:first-child { border-top: 0; }
.tb-agent-work-copy { display: flex; flex-direction: column; min-width: 0; gap: 4px; }
.tb-agent-work-copy strong { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb-agent-work-copy small, .tb-work-status { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.tb-work-state { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.tb-work-state[data-status='in_progress'] { background: #d7a100; }
.tb-work-state[data-status='in_review'] { background: #29a16b; }
.tb-work-state[data-status='done'] { background: var(--dsw-alias-brand-primary); }
.tb-agent-list-empty { margin: 0; padding: 28px 0; color: var(--dsw-alias-label-secondary); text-align: center; }
.tb-agent-work-panel .tb-agent-work-row { min-height: 62px; }
.tb-capability-panel { padding-top: 0; }
.tb-capability-copy { padding: 22px 2px 8px; }
.tb-capability-copy p { color: var(--dsw-alias-label-secondary); line-height: 1.65; }
.tb-agent-settings { display: flex; flex-direction: column; gap: 16px; }
.tb-settings-actions { display: flex; justify-content: flex-end; }
.tb-danger-panel { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, var(--dsw-alias-border-l1)); border-radius: 12px; }
.tb-danger-panel p { margin: 5px 0 0; color: var(--dsw-alias-label-secondary); }
.tb-agent-chip { padding: 1px 7px; border-radius: 999px; font-size: 11px; color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.tb-task-inspector label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tb-task-inspector select, .tb-comment-composer textarea {
  box-sizing: border-box; width: 100%; padding: 8px 10px; font: inherit;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}

/* Inbox event rail and detail split. */
.tb-inbox-split { display: grid; grid-template-columns: minmax(290px, 34%) 1fr; min-height: 600px; border-top: 1px solid var(--dsw-alias-border-l1); }
.tb-inbox-rail { border-right: 1px solid var(--dsw-alias-border-l1); }
.tb-inbox-item {
  position: relative; display: flex; width: 100%; gap: 9px; padding: 14px 14px 14px 18px;
  border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer;
}
.tb-inbox-item:hover, .tb-inbox-item[data-active] { background: var(--dsw-alias-interactive-bg-hover); }
.tb-inbox-item[data-active]::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--dsw-alias-brand-primary); }
.tb-inbox-dot { flex: 0 0 auto; width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; background: transparent; }
.tb-inbox-item[data-unread] .tb-inbox-dot { background: var(--dsw-alias-brand-primary); }
.tb-inbox-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.tb-inbox-copy > span:first-child { display: flex; justify-content: space-between; gap: 8px; }
.tb-inbox-copy time, .tb-inbox-copy small { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.tb-inbox-summary { color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb-inbox-detail { padding: 28px; max-width: 760px; }
.tb-inbox-detail-head { display: flex; justify-content: space-between; gap: 12px; }
.tb-event-type { display: inline-block; margin-bottom: 8px; color: var(--dsw-alias-brand-primary); font-size: 12px; font-weight: 600; }
.tb-inbox-agent { margin: 22px 0; }
.tb-inbox-body { padding: 18px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); line-height: 1.6; }
.tb-inbox-context { display: flex; flex-direction: column; gap: 7px; margin-top: 22px; }
.tb-inbox-context button { display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.tb-inbox-context button small { color: var(--dsw-alias-brand-primary); }
.tb-inbox-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 24px; }

/* Full task document with a persistent property inspector. */
.tb-task-document { display: grid; grid-template-columns: minmax(0, 1fr) 280px; min-height: 650px; }
.tb-task-main { padding: 24px min(5vw, 64px); border-right: 1px solid var(--dsw-alias-border-l1); }
.tb-task-main > .tb-card { cursor: default; border: 0; background: transparent; padding: 0; gap: 14px; }
.tb-task-main > .tb-card .tb-card-title { font-size: 24px; line-height: 1.35; cursor: pointer; }
.tb-task-main > .tb-card .tb-card-edit { opacity: 1; }
.tb-task-inspector { display: flex; flex-direction: column; gap: 15px; padding: 22px 18px; background: var(--dsw-alias-bg-layer-1); }
.tb-comment-composer { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--dsw-alias-border-l1); }

@media (max-width: 900px) {
  .tb-board-toolbar { align-items: flex-start; }
  .tb-board-projects { order: 3; width: 100%; }
  .tb-search { margin-left: auto; }
  .tb-columns { padding-bottom: 180px; }
  .tb-agent-row { grid-template-columns: minmax(180px, 2fr) 1fr .8fr; }
  .tb-agent-row > :nth-child(3), .tb-agent-row > :nth-child(4), .tb-agent-row > :nth-child(5), .tb-agent-row > :nth-child(6) { display: none; }
  .tb-agent-overview, .tb-task-document { grid-template-columns: 1fr; }
  .tb-agent-toolbar { flex-wrap: wrap; }
  .tb-agent-sort { margin-left: 0; }
  .tb-create-cards { grid-template-columns: 1fr; }
  .tb-task-inspector { border-top: 1px solid var(--dsw-alias-border-l1); }
  .tb-inbox-split { grid-template-columns: 1fr; }
  .tb-inbox-rail { border-right: 0; }
}

@media (max-width: 620px) {
  .tb-board-head { padding-inline: 14px; }
  .tb-board-toolbar { padding-inline: 14px; }
  .tb-board-scopes { width: 100%; }
  .tb-board-scopes .tb-filter-chip { flex: 1; }
  .tb-search { order: 2; width: 100%; flex-basis: 100%; }
  .tb-bar-end { order: 4; width: 100%; margin-left: 0; overflow-x: auto; }
  .tb-sched { padding-inline: 14px; overflow-x: auto; }
  .tb-columns { padding-inline: 14px; }
  .tb-column { flex-basis: min(280px, calc(100vw - 52px)); }
  .tb-task-create-dialog { width: calc(100vw - 16px); max-height: calc(100vh - 16px); border-radius: 13px; }
  .tb-task-create-shell { min-height: min(570px, calc(100vh - 16px)); }
  .tb-task-create-head { padding-inline: 14px; }
  .tb-task-create-breadcrumb > span:first-child { max-width: min(160px, 45vw); }
  .tb-task-create-main { padding: 18px 16px 14px; }
  .tb-task-title-field { font-size: 20px; }
  .tb-task-description-field { min-height: 130px; }
  .tb-task-create-footer { flex-wrap: wrap; }
  .tb-task-mode-switch { order: 1; }
  .tb-task-keep-open { order: 2; }
  .tb-task-create-footer > button:last-child { order: 3; width: 100%; margin-left: 0; }
  .tb-agent-title > small { display: none; }
  .tb-agent-toolbar { align-items: stretch; }
  .tb-agent-toolbar .tb-hub-search { width: 100%; }
  .tb-agent-scopes { width: 100%; overflow-x: auto; }
  .tb-agent-row { grid-template-columns: minmax(0, 1fr) auto; padding-inline: 4px; }
  .tb-agent-row > :not(:first-child):not(:second-child) { display: none; }
  .tb-agent-row-head > :nth-child(2) { display: block; }
  .tb-agent-table { padding-inline: 12px; }
  .tb-create-method, .tb-builder-setup, .tb-agent-config { width: calc(100% - 28px); padding-top: 34px; }
  .tb-create-card { min-height: 128px; padding: 18px; }
  .tb-config-grid, .tb-permission-options { grid-template-columns: 1fr; }
  .tb-agent-identity-editor { grid-template-columns: 1fr; }
  .tb-agent-detail { padding: 20px 14px 60px; }
  .tb-agent-hero { align-items: flex-start; flex-wrap: wrap; }
  .tb-agent-hero-actions { width: 100%; margin-left: 80px; }
  .tb-detail-tabs { gap: 14px; overflow-x: auto; }
  .tb-agent-work-row { grid-template-columns: auto minmax(0, 1fr) auto; }
  .tb-agent-work-row .tb-link { grid-column: 2 / -1; justify-self: start; }
}

/* The delete affordance: destructive, so it borrows the error palette — but
   the actual removal still needs the card's confirm step, which is the fence
   a drag-adjacent click cannot cross. */
.tb-danger-zone { margin-top: 4px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2); }
.tb-delete {
  color: var(--dsw-alias-state-error-primary);
  border: 1px solid var(--dsw-alias-state-error-secondary);
}
.tb-delete:hover {
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-secondary);
}
.tb-delete-confirm {
  background: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.tb-delete-ask { font-size: 12px; color: var(--dsw-alias-state-error-primary); }

/* Keyboard focus: same ring the host uses, on every board control. */
.tb-toggle:focus-visible,
.tb-search:focus-visible,
.tb-reason:focus-visible,
.tb-preset:focus-visible,
.tb-card-title:focus-visible,
.tb-session-chip:focus-visible,
.tb-link:focus-visible,
.tb-sched-field input:focus-visible,
.tb-new-project:focus-visible,
.tb-side-new:focus-visible,
.tb-side-entry:focus-visible,
.tb-title-input:focus-visible,
.tb-desc-input:focus-visible,
.tb-label-add:focus-visible,
.tb-card-edit:focus-visible,
.tb-label-x:focus-visible,
.tb-column-add:focus-visible,
.tb-filter-chip:focus-visible,
.tb-task-create-close:focus-visible,
.tb-task-mode-switch:focus-visible,
.tb-task-icon-button:focus-visible,
.tb-task-property:focus-within {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
`

/** Marker so a remount does not stack duplicate sheets. */
const STYLE_ID = 'dsh-task-hub/client'

/**
 * Inject the stylesheet once.
 * @returns a disposer that removes it.
 */
export function installStyles(): () => void {
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.pluginCss = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
