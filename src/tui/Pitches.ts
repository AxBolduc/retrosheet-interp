/**
 * Retrosheet pitch sequences (`BCFX`, `BB>S.C`...): what each code means and
 * the count they add up to.
 */
import type { Count } from "../retrosheet/Record.ts"

export const pitchCodes: ReadonlyArray<readonly [string, string]> = [
  ["B", "ball"],
  ["C", "called strike"],
  ["S", "swinging strike"],
  ["F", "foul"],
  ["X", "in play"],
  ["T", "foul tip"],
  ["H", "hit batter"],
  ["I", "intentional ball"],
  ["L", "foul bunt"],
  ["M", "missed bunt"],
  ["K", "strike (unknown type)"],
  ["P", "pitchout"],
  ["V", "auto ball"],
  ["U", "unknown"],
  ["1", "pickoff throw to 1st"],
  ["2", "pickoff throw to 2nd"],
  ["3", "pickoff throw to 3rd"],
  ["*", "blocked by catcher (prefix)"],
  [">", "runner going (prefix)"],
  ["+", "catcher pickoff throw (prefix)"]
]

const codeSet = new Set(pitchCodes.map(([c]) => c).concat(["N", "O", "Q", "R", "Y", "."]))

/** Is `ch` something that can appear in a pitch sequence? */
export const isPitchCode = (ch: string): boolean => codeSet.has(ch.toUpperCase())

const balls = new Set(["B", "I", "P", "V"])
const strikes = new Set(["C", "S", "K", "M", "O", "Q", "T"])
const fouls = new Set(["F", "R"])

/** The count after every pitch in the sequence (balls up to 4, strikes up to 3). */
export const countAfter = (pitches: string): Count => {
  let b = 0
  let s = 0
  for (const ch of pitches.toUpperCase()) {
    if (balls.has(ch)) b = Math.min(4, b + 1)
    else if (strikes.has(ch)) s = Math.min(3, s + 1)
    else if (ch === "L") s = Math.min(3, s + 1)
    else if (fouls.has(ch) && s < 2) s++
  }
  return { balls: b, strikes: s }
}

/** Has the pitch sequence already decided the plate appearance? Suggest the event if so. */
export const impliedEvent = (pitches: string): string | undefined => {
  const p = pitches.toUpperCase().replace(/[^A-Z]/g, "")
  const last = p[p.length - 1]
  if (last === "H") return "HP"
  const { balls, strikes } = countAfter(p)
  if (balls >= 4) return last === "I" ? "IW" : "W"
  if (strikes >= 3) return "K"
  return undefined
}

/** Is the ball in play (the last pitch is X or Y)? */
export const inPlay = (pitches: string): boolean => /[XY]$/i.test(pitches.replace(/[^A-Z]/gi, ""))
