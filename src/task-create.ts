/** Pure helpers shared by the task creation UI and its tests. */

/** Maximum title length derived from a natural-language task request. */
const DERIVED_TITLE_LIMIT = 72

/**
 * Derive a compact board title from a natural-language task request.
 *
 * The first non-empty line is the user's strongest title signal. Long prompts
 * remain intact in the description while the card title is clipped cleanly.
 * @param prompt - Natural-language request entered in agent mode.
 * @returns a board title and the normalized full request.
 */
export function deriveTaskDraft(prompt: string): { title: string; description: string } {
  const description = prompt.trim()
  const firstLine =
    description
      .split(/\r?\n/u)
      .find(line => line.trim() !== '')
      ?.trim() ?? ''
  const title =
    firstLine.length <= DERIVED_TITLE_LIMIT
      ? firstLine
      : `${firstLine.slice(0, DERIVED_TITLE_LIMIT - 1).trimEnd()}…`
  return { title, description }
}
