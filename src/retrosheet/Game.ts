/**
 * The state of a game being scored. Values are plain, immutable-by-convention
 * data so states can be snapshotted cheaply for undo and history.
 */
import type { Count, Side } from "./Record.ts"

export interface Player {
  readonly id: string
  readonly name: string
  readonly side: Side
}

export interface Runner {
  readonly playerId: string
  /** Pitcher charged if this runner scores. */
  readonly responsiblePitcherId: string | undefined
}

export interface TeamState {
  readonly code: string | undefined
  /** Index 1-9 are batting-order slots; index 0 holds a pitcher who does not bat (DH games). */
  readonly lineup: ReadonlyArray<string | undefined>
  /** Index 1-10 (10 = DH): player at each defensive position. */
  readonly fielders: ReadonlyArray<string | undefined>
  /**
   * Position of every player who has appeared (11 = PH, 12 = PR until they take the field).
   * Players who have left the game keep their last position.
   */
  readonly positions: Readonly<Record<string, number>>
  /** Batting-order slot (1-9) of the next batter. */
  readonly nextSlot: number
  /** Batting-order slot each player occupied (0 = non-batting pitcher). */
  readonly battingSlots: Readonly<Record<string, number>>
  /** All players who have appeared, in order of appearance. */
  readonly appeared: ReadonlyArray<string>
  /** Players who have been removed from the game. */
  readonly removed: ReadonlyArray<string>
  /** Pitchers in order of appearance. */
  readonly pitchers: ReadonlyArray<string>
}

export interface BattingLine {
  readonly pa: number
  readonly ab: number
  readonly r: number
  readonly h: number
  readonly d: number
  readonly t: number
  readonly hr: number
  readonly rbi: number
  readonly bb: number
  readonly ibb: number
  readonly so: number
  readonly hbp: number
  readonly sh: number
  readonly sf: number
  readonly sb: number
  readonly cs: number
  readonly gdp: number
}

export interface PitchingLine {
  readonly outs: number
  readonly bf: number
  readonly h: number
  readonly r: number
  readonly er: number | undefined
  readonly bb: number
  readonly ibb: number
  readonly so: number
  readonly hbp: number
  readonly hr: number
  readonly wp: number
  readonly bk: number
}

export const emptyBattingLine: BattingLine = {
  pa: 0,
  ab: 0,
  r: 0,
  h: 0,
  d: 0,
  t: 0,
  hr: 0,
  rbi: 0,
  bb: 0,
  ibb: 0,
  so: 0,
  hbp: 0,
  sh: 0,
  sf: 0,
  sb: 0,
  cs: 0,
  gdp: 0
}

export const emptyPitchingLine: PitchingLine = {
  outs: 0,
  bf: 0,
  h: 0,
  r: 0,
  er: undefined,
  bb: 0,
  ibb: 0,
  so: 0,
  hbp: 0,
  hr: 0,
  wp: 0,
  bk: 0
}

/** Bases 1, 2, 3 at indices 0, 1, 2. */
export type Bases = readonly [Runner | undefined, Runner | undefined, Runner | undefined]

export interface PlayLogEntry {
  /** Sequence number of the play within the game (1-based). */
  readonly number: number
  readonly inning: number
  readonly battingSide: Side
  readonly batterId: string
  readonly pitcherId: string | undefined
  readonly count: Count | undefined
  readonly pitches: string
  readonly event: string
  readonly description: string
  readonly outsBefore: number
  readonly outsAfter: number
  readonly basesBefore: Bases
  readonly basesAfter: Bases
  readonly runsScored: ReadonlyArray<string>
  /** Runs batted in by the batter on this play. */
  readonly rbi: number
  readonly scoreAfter: readonly [number, number]
}

export type GamePhase = "pregame" | "in-progress" | "final"

export interface GameState {
  readonly gameId: string | undefined
  readonly version: string | undefined
  readonly info: ReadonlyArray<readonly [string, string]>
  readonly scheduledInnings: number
  readonly players: Readonly<Record<string, Player>>
  readonly teams: readonly [TeamState, TeamState]
  readonly phase: GamePhase
  readonly inning: number
  readonly battingSide: Side
  readonly outs: number
  readonly bases: Bases
  readonly score: readonly [number, number]
  /** Runs per inning for each side (index 0 = 1st inning). */
  readonly lineScore: readonly [ReadonlyArray<number>, ReadonlyArray<number>]
  readonly hits: readonly [number, number]
  readonly errors: readonly [number, number]
  readonly leftOnBase: readonly [number, number]
  readonly batting: Readonly<Record<string, BattingLine>>
  readonly pitching: Readonly<Record<string, PitchingLine>>
  readonly plays: ReadonlyArray<PlayLogEntry>
  readonly comments: ReadonlyArray<{ readonly afterPlay: number; readonly text: string }>
  readonly notes: ReadonlyArray<string>
  /** Pitches/count recorded so far in the current plate appearance (from NP / runner events). */
  readonly currentCount: Count | undefined
  readonly currentPitches: string
}

const emptyTeam = (): TeamState => ({
  code: undefined,
  lineup: Array.from({ length: 10 }, () => undefined),
  fielders: Array.from({ length: 11 }, () => undefined),
  positions: {},
  battingSlots: {},
  nextSlot: 1,
  appeared: [],
  removed: [],
  pitchers: []
})

export const initialGame = (gameId: string | undefined): GameState => ({
  gameId,
  version: undefined,
  info: [],
  scheduledInnings: 9,
  players: {},
  teams: [emptyTeam(), emptyTeam()],
  phase: "pregame",
  inning: 1,
  battingSide: 0,
  outs: 0,
  bases: [undefined, undefined, undefined],
  score: [0, 0],
  lineScore: [[], []],
  hits: [0, 0],
  errors: [0, 0],
  leftOnBase: [0, 0],
  batting: {},
  pitching: {},
  plays: [],
  comments: [],
  notes: [],
  currentCount: undefined,
  currentPitches: ""
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const otherSide = (side: Side): Side => (side === 0 ? 1 : 0)

export const infoValue = (game: GameState, key: string): string | undefined =>
  game.info.findLast(([k]) => k === key)?.[1]

export const teamCode = (game: GameState, side: Side): string =>
  game.teams[side].code ?? (side === 0 ? "Visitor" : "Home")

export const playerName = (game: GameState, id: string | undefined): string =>
  id === undefined ? "(none)" : game.players[id]?.name ?? id

export const currentBatterId = (game: GameState): string | undefined => {
  const team = game.teams[game.battingSide]
  return team.lineup[team.nextSlot]
}

export const currentPitcherId = (game: GameState): string | undefined =>
  game.teams[otherSide(game.battingSide)].fielders[1]

/** The next `n` batters due up for a side, starting with the current one. */
export const dueUp = (game: GameState, side: Side, n: number): ReadonlyArray<{ slot: number; playerId: string | undefined }> => {
  const team = game.teams[side]
  return Array.from({ length: n }, (_, i) => {
    const slot = ((team.nextSlot - 1 + i) % 9) + 1
    return { slot, playerId: team.lineup[slot] }
  })
}

export const positionAbbrev = (pos: number | undefined): string =>
  pos === undefined ? "-" : ["?", "P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH", "PH", "PR"][pos] ?? "?"

export const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

export const halfName = (game: Pick<GameState, "inning" | "battingSide">): string =>
  `${game.battingSide === 0 ? "Top" : "Bottom"} of the ${ordinal(game.inning)}`

/** Lower-case form for use mid-sentence: "top of the 3rd". */
export const halfPhrase = (game: Pick<GameState, "inning" | "battingSide">): string =>
  `${game.battingSide === 0 ? "top" : "bottom"} of the ${ordinal(game.inning)}`
