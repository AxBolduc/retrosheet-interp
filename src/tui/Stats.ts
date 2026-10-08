/**
 * Small per-player summaries for the UI.
 */
import { endsPlateAppearance, parseEvent } from "../retrosheet/Event.ts"
import type { GameState } from "../retrosheet/Game.ts"
import { Effect, Option } from "effect"

const pitchLetters = /[BCFHIKLMOPQRSTUVXY]/g

const endsPA = (event: string) =>
  Option.match(Effect.runSync(Effect.option(parseEvent(event))), {
    onNone: () => false,
    onSome: (e) => endsPlateAppearance(e.basic)
  })

/**
 * Pitches thrown by a pitcher, counted from the pitch sequences of the plate
 * appearances he finished (sequences repeat across runner events, so only the
 * last record of each plate appearance counts), plus pitches in progress.
 */
export const pitchCount = (game: GameState, pitcherId: string, inProgress = ""): number => {
  let n = 0
  for (const play of game.plays) {
    if (play.pitcherId === pitcherId && endsPA(play.event)) n += (play.pitches.match(pitchLetters) ?? []).length
  }
  return n + (inProgress.match(pitchLetters) ?? []).length
}

/** "2-for-3", plus notable extras: "2-for-3, HR, 2 RBI, BB". */
export const battingSummary = (game: GameState, playerId: string): string => {
  const l = game.batting[playerId]
  if (l === undefined || l.pa === 0) return ""
  const extras: Array<string> = []
  const count = (n: number, label: string) => {
    if (n > 0) extras.push(n > 1 ? `${n} ${label}` : label)
  }
  count(l.hr, "HR")
  count(l.d, "2B")
  count(l.t, "3B")
  count(l.rbi, "RBI")
  count(l.bb, "BB")
  count(l.so, "K")
  count(l.sb, "SB")
  return [`${l.h}-${l.ab}`, ...extras].join(", ")
}

export const inningsPitched = (outs: number): string => `${Math.floor(outs / 3)}.${outs % 3}`
