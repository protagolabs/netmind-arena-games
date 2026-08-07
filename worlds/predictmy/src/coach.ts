/**
 * The assistant coach's tool and instructions — the one part of this port that
 * is NOT the source's own code.
 *
 * `src/world.ts` opens by saying this is a PORT, not a reinterpretation, and
 * every other file keeps that promise: the engine, the markup, the stylesheet
 * and the whole 11v11 simulation come verbatim from the shipped build. This file
 * is the exception, and it exists because of where predictmy.ai drew its own
 * line.
 *
 * The deployed bundle contains BOTH ENDS of the coach conversation and nothing in
 * between. It builds a request (`/api/chat` with `{messages, context}`) and it
 * consumes a reply (`Jn(block.input)` turns the model's tool arguments into a
 * tactics patch). What sits between them — the system prompt and the tool
 * definition — lived on the site's server and is not in anything a browser
 * receives. It cannot be extracted, only re-written.
 *
 * So this file is split by how much is actually known:
 *
 *   CONFIRMED, read straight out of the vendored build. Every field name, every
 *   enum value and every "0 means stop" convention below comes from `Gn`/`Jn` in
 *   `vendor/main.js`. These are not choices — a field this file spells
 *   differently is a field the page silently ignores, and the order would appear
 *   to be accepted while changing nothing.
 *
 *   INFERRED, reconstructed from the evidence the build does carry: the twelve
 *   quick commands (`Ht` in `vendor/redeemCode.js`), and the bilingual rule
 *   parser the site ships for when its own model is unavailable (`Dt`, same
 *   file). That parser is the closest thing to a specification that survives —
 *   it maps phrases to the same deltas the model is supposed to produce, so its
 *   magnitudes are used here as the scale a well-behaved order sits on.
 *
 * What cannot be claimed: that this reproduces the original coach's wording,
 * personality or judgement. It reproduces its INTERFACE and, as far as the rule
 * table shows, its sense of proportion. A visitor who used predictmy.ai will
 * find the same orders work; they may not find the same coach.
 */

import type { AiTool } from '@arena/world-sdk'

/**
 * A continuous knob, as the page applies it.
 *
 * `Gn` keeps only finite non-zero numbers, so 0 and "absent" are the same thing
 * — there is no way to express "set this to zero", only "leave it alone". Every
 * value is a DELTA added to the current policy, not a target.
 */
const delta = (description: string) => ({ type: 'number', description })

/**
 * Typical magnitude, taken from the rule table (`Mt`): ±0.3 for a normal order,
 * ±0.4 for an emphatic one. Stated in the schema because a model with no anchor
 * reaches for 1 every time, and a coach who answers every instruction by pinning
 * a slider to its limit is not following the instruction.
 */
const NUDGE = 'Delta on the current value, not a target. ±0.3 for a normal order, ±0.4 for an emphatic one.'
/** The positional knobs are in pitch units rather than [-1,1]. */
const SHIFT = 'Delta in pitch units. ±6 to ±8 for a normal order, ±12 for an emphatic one.'

/**
 * CONFIRMED — every property here is read by `Gn`/`Jn` in `vendor/main.js`.
 * Renaming one does not break anything visibly; it just stops working.
 */
export const COACH_TOOL: AiTool = {
  name: 'set_tactics',
  description:
    'Apply the coach’s instruction to the selected player, or to the whole team when the head coach is selected. ' +
    'Send ONLY the fields the instruction actually changes — every field is a delta, and an unsent field is left alone.',
  input_schema: {
    type: 'object',
    properties: {
      // — the twelve continuous knobs, in `Hn` order —
      pressing: delta(`How aggressively they close the ball down. ${NUDGE}`),
      passTendency: delta(`Preference for passing over carrying. ${NUDGE}`),
      shootTendency: delta(`Willingness to shoot rather than continue the move. ${NUDGE}`),
      dribbleTendency: delta(`Preference for taking players on. ${NUDGE}`),
      riskTolerance: delta(`Appetite for the ambitious ball over the safe one. ${NUDGE}`),
      longBall: delta(`Preference for the long ball over playing out short. ${NUDGE}`),
      width: delta(`Positive uses the flanks, negative plays narrow through the middle. ${NUDGE}`),
      discipline: delta(`Positive holds shape and position, negative is a free role. ${NUDGE}`),
      range: delta(`How far they roam from their position. ${SHIFT}`),
      supportDistance: delta(`Negative comes short for the ball, positive supports from distance. ${SHIFT}`),
      homeForward: delta(`Positive pushes their base position up the pitch, negative sits deeper. ${SHIFT}`),
      homeLateral: delta(`Negative shifts them left, positive right, 0 is central. ${SHIFT}`),

      // — zone lock —
      zoneKey: {
        type: 'string',
        enum: ['TR', 'TL', 'BR', 'BL', 'ATT', 'DEF', 'MID', 'CLEAR'],
        description:
          'Confine them to a region of the pitch: a quadrant (TR/TL/BR/BL), the attacking, defensive or middle ' +
          'third (ATT/DEF/MID), or CLEAR to lift an existing restriction.',
      },

      // — a timed run —
      runTarget: {
        type: 'string',
        enum: ['OPP_BOX', 'OWN_BOX', 'CENTER'],
        description: 'Send them on a run: into the opponent’s box, back to their own, or to the centre.',
      },
      runSeconds: { type: 'number', description: 'How long that run lasts, in seconds.' },

      // — beliefs, team-level: `Jn` applies these only when a team or the head coach is selected —
      attackChannel: {
        type: 'number',
        description:
          'Which flank to attack down: negative for the left, positive for the right, ±0.6 for a clear preference. ' +
          'Team-level; ignored when a single player is selected.',
      },
      inBehind: {
        type: 'number',
        description:
          'Positive plays balls in behind the defence, negative plays to feet (±0.4 to ±0.5). ' +
          'Team-level; ignored when a single player is selected.',
      },

      // — man-marking and service, by shirt number —
      markOpponent: {
        type: 'number',
        description:
          'Shirt number of the opponent to man-mark. 0 cancels an existing assignment. ' +
          'Only meaningful when one of your players is selected.',
      },
      feedTeammate: {
        type: 'number',
        description: 'Shirt number of the teammate to look for with the ball. 0 goes back to spreading the passes.',
      },

      // — scope —
      target: {
        type: 'string',
        enum: ['team'],
        description:
          'Set to "team" to apply the instruction to every player rather than only the selected one. ' +
          'Omit for an instruction aimed at one player.',
      },
    },
    additionalProperties: false,
  },
}

/** The nine languages the page ships strings for, and therefore the nine it may be read in. */
const LANG_NAMES: Record<string, string> = {
  en: 'English',
  zh: 'Chinese',
  es: 'Spanish',
  ru: 'Russian',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
}

/**
 * INFERRED — the coach's brief.
 *
 * Written against what the rest of the page demonstrably expects: it renders one
 * short line of text per reply beside the applied-change summary it builds
 * itself, so a long answer is a long answer nobody reads. The tone target is the
 * quick commands ("Press High", "Play Safe") — a touchline instruction, not an
 * analysis.
 *
 * @param lang  Arena's current base language code; the page is translated into
 *              all nine, so a coach answering in English inside a Japanese UI
 *              would be the only untranslated thing on screen.
 * @param context the page's own live match snapshot (`Kn()` in vendor/main.js).
 *              It travels in the system prompt rather than as a message because
 *              it is regenerated on every call, while `messages` is the
 *              conversation the page owns and replays.
 */
export function coachSystem(lang: string, context: unknown): string {
  const language = LANG_NAMES[lang] ?? 'English'
  return [
    'You are the assistant coach in a live 11-a-side football match simulation.',
    'The head coach speaks to you from the touchline. Turn what they say into tactical settings.',
    '',
    'Rules:',
    `1. ALWAYS call the set_tactics tool. That call is the only thing that changes the match; text alone does nothing.`,
    '2. Send only the fields the instruction actually changes. Every field is a delta on the current value, so an',
    '   unsent field is left as it is, and a field you send needlessly overrides something the coach set earlier.',
    '3. Match the size of the change to the strength of the order. A normal instruction is ±0.3; save larger values',
    '   for one that is emphatic. Never pin a value to its limit because the coach sounded urgent.',
    '4. If an order is about the whole side rather than one player, set target to "team".',
    '5. If you genuinely cannot tell what is being asked, call the tool with no fields and say so briefly.',
    '',
    `6. Reply in ${language}, in one short line — what you are changing and why, as you would shout it across a`,
    '   touchline. The interface already lists the settings you changed, so do not repeat them.',
    '',
    'Current match state:',
    JSON.stringify(context),
  ].join('\n')
}
