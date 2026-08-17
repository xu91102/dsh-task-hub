/**
 * Ships the board's working agreement as a registered skill.
 *
 * dashi-taskboard asked the user to symlink its skill into the harness's skills
 * directory. `ctx.skills.register` makes that step disappear: installing the
 * plugin installs the skill, and unloading it withdraws it.
 *
 * The skill is deliberately thin. The original spent most of its length teaching
 * an agent to drive a CLI; the tools carry that now, so what is left is the part
 * a tool schema cannot express — when to comment, what a good proposal looks
 * like, and why finishing is not accepting.
 * @module dsh-task-hub/skill
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

/** Packaged skill body, read once at mount. */
function readSkillBody(): string {
  // lib/skill.js → package root → skills/manage-taskboard/SKILL.md
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const raw = readFileSync(join(packageRoot, 'skills', 'manage-taskboard', 'SKILL.md'), 'utf8')
  // Drop the frontmatter: the registry takes name/description as fields.
  return raw.replace(/^---\n[\s\S]*?\n---\n/u, '').trim()
}

/**
 * Register the board's skill.
 * @param ctx - Context that already has `skills`.
 */
export function applySkill(ctx: Context): void {
  let content: string
  try {
    content = readSkillBody()
  } catch (error) {
    // A missing skill file must not take the board down with it.
    ctx.logger.warn('taskboard: skill body unavailable, skipping registration', error)
    return
  }

  ctx.effect(
    () =>
      ctx.skills.register({
        name: 'manage-taskboard',
        description:
          'How to work an issue on the task board — claim it, report progress, and hand it back. ' +
          'Use whenever you pick up, update, or finish a board issue, or want to propose new work.',
        // `bundled`: it ships inside this plugin rather than being discovered on disk.
        source: 'bundled',
        content,
      }),
    'taskboard: skill',
  )
}
