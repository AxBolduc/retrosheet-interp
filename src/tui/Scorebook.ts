/**
 * A traditional scorebook page for one team, computed from the play log:
 * one row per batting-order slot, one column per inning (or more, when the
 * team bats around), and in each cell the result of the plate appearance and
 * how far the batter got around the bases.
 */
import { Effect, Option } from "effect"
import { endsPlateAppearance, parseEvent, type ParsedEvent } from "../retrosheet/Event.ts"
import { type GameState, type PlayLogEntry, playerName, positionAbbrev } from "../retrosheet/Game.ts"
import type { Side } from "../retrosheet/Record.ts"

export interface ScorebookCell {
  /** Index of the plate appearance's play in `game.plays`. */
  readonly playIndex: number
  readonly event: string
  /** Short scorebook notation: `6-3`, `1B8`, `K`, `BB`, `F8`. */
  readonly notation: string
  /** Extra tags for the play: `DP`, `SF`, `SH`. */
  readonly tags: ReadonlyArray<string>
  /** Furthest base reached safely: 0 (none) to 4 (scored). */
  readonly reached: 0 | 1 | 2 | 3 | 4
  /** The out number (1-3), if the batter was put out at the plate or on the bases. */
  readonly out: number | undefined
  /** Stranded when the half inning ended. */
  readonly leftOnBase: boolean
  /** How the runner advanced after reaching: batting slot numbers or runner events (`SB`, `WP`). */
  readonly advances: ReadonlyArray<string>
  /** Runs batted in on this play. */
  readonly rbi: number
}

export interface ScorebookColumn {
  readonly inning: number
  /** 0 for the first time through the order in this inning, 1 when the team bats around, ... */
  readonly pass: number
}

export interface ScorebookPlayer {
  readonly id: string
  readonly name: string
  readonly position: string
  /** The player has been replaced in this slot. */
  readonly removed: boolean
}

export interface ScorebookRow {
  readonly slot: number
  readonly players: ReadonlyArray<ScorebookPlayer>
}

export interface InningTotals {
  readonly runs: number
  readonly hits: number
  readonly errors: number
  readonly leftOnBase: number
}

export interface Scorebook {
  readonly side: Side
  readonly columns: ReadonlyArray<ScorebookColumn>
  readonly rows: ReadonlyArray<ScorebookRow>
  /** Keyed by `${slot}:${columnIndex}`. */
  readonly cells: ReadonlyMap<string, ScorebookCell>
  /** Per inning (index 0 = 1st), for this team at bat; errors are the opponent's, made in those half innings. */
  readonly totals: ReadonlyArray<InningTotals>
  /** Where the next plate appearance goes, if this team is batting. */
  readonly current: { readonly slot: number; readonly column: number } | undefined
}

export const cellKey = (slot: number, column: number) => `${slot}:${column}`

const parse = (event: string): Option.Option<ParsedEvent> => Effect.runSync(Effect.option(parseEvent(event)))

const trajectory = (modifiers: ReadonlyArray<string>): string | undefined => {
  for (const m of modifiers) {
    const t = /^(BG|BP|BL|G|L|F|P)/.exec(m)?.[1]
    if (t !== undefined) return t
  }
  return undefined
}

/** Remove consecutive repeats: `8-8-4` → `8-4`. */
const dedupe = (digits: ReadonlyArray<string>) => digits.filter((d, i) => i === 0 || d !== digits[i - 1])

const hitNames = { Single: "1B", Double: "2B", Triple: "3B", HomeRun: "HR", GroundRuleDouble: "GRD" } as const

/** Scorebook shorthand for an event, e.g. `64(1)3/GDP` → `6-4-3` with a `DP` tag. */
export const notation = (event: string, pitches = ""): { readonly text: string; readonly tags: ReadonlyArray<string> } => {
  const parsed = parse(event)
  if (Option.isNone(parsed)) return { text: event.split(/[./]/)[0] ?? event, tags: [] }
  const { basic, modifiers } = parsed.value
  const tags: Array<string> = []
  if (modifiers.some((m) => /^(GDP|LDP|DP|BGDP|BPDP|FDP)$/.test(m))) tags.push("DP")
  if (modifiers.some((m) => /^(GTP|LTP|TP)$/.test(m))) tags.push("TP")
  if (modifiers.includes("SF")) tags.push("SF")
  if (modifiers.includes("SH")) tags.push("SH")
  switch (basic._tag) {
    case "FieldedOut": {
      const digits = dedupe(basic.putouts.flatMap((p) => p.fielders.split("")))
      if (basic.putouts.length > 1 && !tags.includes("DP") && !tags.includes("TP")) {
        tags.push(basic.putouts.length === 2 ? "DP" : "TP")
      }
      if (digits.length === 1) {
        const t = trajectory(modifiers)
        const d = digits[0]!
        return { text: t === undefined ? d : t.startsWith("G") || t === "BG" ? `${d}U` : `${t[t.length - 1]}${d}`, tags }
      }
      return { text: digits.join("-"), tags }
    }
    case "Hit":
      return { text: `${hitNames[basic.kind]}${basic.fielders.slice(0, 1)}`, tags }
    case "ReachedOnError":
      return { text: `E${basic.fielder}`, tags }
    case "FieldersChoice":
      return { text: `FC${basic.fielders.slice(0, 1)}`, tags }
    case "Strikeout": {
      const last = pitches.replace(/[^A-Z]/gi, "").slice(-1).toUpperCase()
      const looking = last === "C"
      const extra = basic.extra.length > 0 ? "+" : ""
      return { text: `${looking ? "Kc" : "K"}${basic.fielders.length > 1 ? basic.fielders : ""}${extra}`, tags }
    }
    case "Walk":
      return { text: basic.intentional ? "IBB" : "BB", tags }
    case "HitByPitch":
      return { text: "HBP", tags }
    case "Interference":
      return { text: "CI", tags }
    default:
      return { text: event.split(/[./]/)[0] ?? event, tags }
  }
}

/** Short label for a runner-only event, as written next to the base path. */
const runnerEventLabel = (event: string): string => {
  const m = /^(SB|CS|POCS|PO|WP|PB|BK|DI|OA)/.exec(event)
  return m?.[1] ?? event.slice(0, 2)
}

const sameHalf = (a: PlayLogEntry, b: PlayLogEntry) => a.inning === b.inning && a.battingSide === b.battingSide

const isRunnerOnly = (event: string) =>
  Option.match(parse(event), { onNone: () => false, onSome: (e) => e.basic._tag === "RunnerOnly" })

const endsPA = (event: string) =>
  Option.match(parse(event), { onNone: () => false, onSome: (e) => endsPlateAppearance(e.basic) })

const baseOf = (bases: PlayLogEntry["basesAfter"], id: string): 0 | 1 | 2 | 3 => {
  const i = bases.findIndex((r) => r?.playerId === id)
  return i === -1 ? 0 : ((i + 1) as 1 | 2 | 3)
}

/** Follow the batter of play `index` around the bases until he scores, is put out, or the half inning ends. */
const followBatter = (game: GameState, index: number) => {
  const plays = game.plays
  const pa = plays[index]!
  let runnerId = pa.batterId
  let reached: 0 | 1 | 2 | 3 | 4 = 0
  let out: number | undefined
  let leftOnBase = false
  const advances: Array<string> = []
  let base: 0 | 1 | 2 | 3 = 0
  for (let j = index; j < plays.length; j++) {
    const play = plays[j]!
    if (!sameHalf(play, pa)) {
      leftOnBase = base > 0
      return { reached, out, leftOnBase, advances }
    }
    if (j > index) {
      // Follow a pinch runner who took over this runner's base between plays.
      runnerId = play.basesBefore[base - 1]?.playerId ?? runnerId
    }
    const scored = play.runsScored.includes(runnerId)
    const now = scored ? 4 : baseOf(play.basesAfter, runnerId)
    if (j > index && now !== base) {
      advances.push(isRunnerOnly(play.event) ? runnerEventLabel(play.event) : String(game.teams[pa.battingSide].battingSlots[play.batterId] ?? ""))
    }
    if (now === 0) {
      out = play.outsAfter > play.outsBefore ? play.outsAfter : undefined
      return { reached, out, leftOnBase: false, advances }
    }
    reached = Math.max(reached, now) as typeof reached
    if (now === 4) return { reached, out, leftOnBase: false, advances }
    base = now as 1 | 2 | 3
    if (play.outsAfter === 3) return { reached, out, leftOnBase: true, advances }
  }
  return { reached, out, leftOnBase: game.phase === "final" && base > 0, advances }
}

export const buildScorebook = (game: GameState, side: Side): Scorebook => {
  const team = game.teams[side]
  const rows: Array<ScorebookRow> = Array.from({ length: 9 }, (_, i) => {
    const slot = i + 1
    const ids = team.appeared.filter((id) => team.battingSlots[id] === slot)
    return {
      slot,
      players: ids.map((id) => ({
        id,
        name: playerName(game, id),
        position: positionAbbrev(team.positions[id]),
        removed: team.removed.includes(id) || team.lineup[slot] !== id
      }))
    }
  })

  const cells = new Map<string, ScorebookCell>()
  const passes = new Map<number, number>() // inning -> number of columns
  const placed: Array<{ slot: number; inning: number; pass: number; cell: ScorebookCell }> = []
  const timesUp = new Map<string, number>() // `${inning}:${slot}` -> PAs so far
  const hits: Array<number> = []
  const lob: Array<number> = []
  const errors: Array<number> = []

  game.plays.forEach((play, index) => {
    if (play.battingSide !== side) return
    const e = (play.event.match(/E[1-9]/g) ?? []).length
    if (e > 0) errors[play.inning - 1] = (errors[play.inning - 1] ?? 0) + e
    if (!endsPA(play.event)) return
    const slot = team.battingSlots[play.batterId]
    if (slot === undefined || slot < 1) return
    const key = `${play.inning}:${slot}`
    const pass = timesUp.get(key) ?? 0
    timesUp.set(key, pass + 1)
    passes.set(play.inning, Math.max(passes.get(play.inning) ?? 1, pass + 1))
    const { text, tags } = notation(play.event, play.pitches)
    const path = followBatter(game, index)
    const parsed = parse(play.event)
    if (Option.isSome(parsed) && parsed.value.basic._tag === "Hit") hits[play.inning - 1] = (hits[play.inning - 1] ?? 0) + 1
    if (path.leftOnBase) lob[play.inning - 1] = (lob[play.inning - 1] ?? 0) + 1
    placed.push({
      slot,
      inning: play.inning,
      pass,
      cell: { playIndex: index, event: play.event, notation: text, tags, ...path, rbi: play.rbi }
    })
  })

  let current: { slot: number; pass: number; inning: number } | undefined
  if (game.phase !== "final" && game.battingSide === side) {
    const slot = team.nextSlot
    const pass = timesUp.get(`${game.inning}:${slot}`) ?? 0
    passes.set(game.inning, Math.max(passes.get(game.inning) ?? 1, pass + 1))
    current = { slot, pass, inning: game.inning }
  }

  const innings = Math.max(game.scheduledInnings, game.inning, ...passes.keys())
  const columns: Array<ScorebookColumn> = []
  const columnIndex = new Map<string, number>()
  for (let inning = 1; inning <= innings; inning++) {
    for (let pass = 0; pass < (passes.get(inning) ?? 1); pass++) {
      columnIndex.set(`${inning}:${pass}`, columns.length)
      columns.push({ inning, pass })
    }
  }
  for (const p of placed) cells.set(cellKey(p.slot, columnIndex.get(`${p.inning}:${p.pass}`)!), p.cell)

  const totals = Array.from({ length: innings }, (_, i) => ({
    runs: game.lineScore[side][i] ?? 0,
    hits: hits[i] ?? 0,
    errors: errors[i] ?? 0,
    leftOnBase: lob[i] ?? 0
  }))

  return {
    side,
    columns,
    rows,
    cells,
    totals,
    current: current === undefined
      ? undefined
      : { slot: current.slot, column: columnIndex.get(`${current.inning}:${current.pass}`)! }
  }
}
