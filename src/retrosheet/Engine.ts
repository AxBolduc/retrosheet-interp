/**
 * The interpreter: applies Retrosheet records to a {@link GameState}.
 *
 * Every application is validated (right inning/half, right batter, runners
 * actually on the bases they advance from, no more than three outs...) and
 * fails with an {@link EngineError} instead of producing an inconsistent state.
 */
import { Data, Effect } from "effect"
import type { DeepMutable } from "effect/Types"
import { baseName, describeEvent } from "./Describe.ts"
import { type Advance, type Dest, endsPlateAppearance, type Origin, parseEvent, type ParsedEvent } from "./Event.ts"
import {
  type BattingLine,
  type Bases,
  currentBatterId,
  currentPitcherId,
  emptyBattingLine,
  emptyPitchingLine,
  type GameState,
  halfPhrase,
  initialGame,
  otherSide,
  type PitchingLine,
  playerName,
  type Runner
} from "./Game.ts"
import type { Appearance, Base, RetroRecord, Side } from "./Record.ts"

export class EngineError extends Data.TaggedError("EngineError")<{
  readonly message: string
}> {}

type Draft = DeepMutable<GameState>

const fail = (message: string) => Effect.fail(new EngineError({ message }))

const sideName = (side: Side) => (side === 0 ? "visitor" : "home")

// ---------------------------------------------------------------------------
// Stat helpers
// ---------------------------------------------------------------------------

const bat = (d: Draft, id: string, f: (l: BattingLine) => Partial<BattingLine>) => {
  const line = d.batting[id] ?? { ...emptyBattingLine }
  d.batting[id] = { ...line, ...f(line) }
}

const pitch = (d: Draft, id: string | undefined, f: (l: PitchingLine) => Partial<PitchingLine>) => {
  if (id === undefined) return
  const line = d.pitching[id] ?? { ...emptyPitchingLine }
  d.pitching[id] = { ...line, ...f(line) }
}

// ---------------------------------------------------------------------------
// Lineups and substitutions
// ---------------------------------------------------------------------------

const applyAppearance = Effect.fnUntraced(function*(d: Draft, a: Appearance, kind: "start" | "sub") {
  const team = d.teams[a.side]
  const existing = d.players[a.playerId]
  if (existing !== undefined && existing.side !== a.side) {
    return yield* fail(`${a.playerId} already appears for the ${sideName(existing.side)} team`)
  }
  if (team.removed.includes(a.playerId)) {
    return yield* fail(`${playerName(d, a.playerId)} has already been removed from the game`)
  }
  if (kind === "start" && d.phase !== "pregame") {
    return yield* fail("start records must come before the first play; use sub for substitutions")
  }
  if (a.position === 11 || a.position === 12) {
    if (a.battingOrder === 0) return yield* fail("a pinch hitter/runner needs a batting-order slot")
  }
  d.players[a.playerId] = { id: a.playerId, name: a.name || existing?.name || a.playerId, side: a.side }
  if (!team.appeared.includes(a.playerId)) team.appeared.push(a.playerId)
  if (team.battingSlots[a.playerId] === undefined || a.battingOrder !== 0) {
    team.battingSlots[a.playerId] = a.battingOrder
  }

  const slot = a.battingOrder
  const previous = team.lineup[slot]
  // A two-way player (the "Ohtani rule") can be both the DH and the non-batting pitcher.
  const twoWay = slot === 0 && team.lineup.some((p, i) => i > 0 && p === a.playerId)
  if (twoWay) {
    team.lineup[0] = a.playerId
    team.fielders[1] = a.playerId
    if (!team.pitchers.includes(a.playerId)) team.pitchers.push(a.playerId)
    if (!d.pitching[a.playerId]) d.pitching[a.playerId] = { ...emptyPitchingLine }
    return
  }
  if (previous !== a.playerId) {
    if (previous !== undefined) {
      const stillPitching = slot !== 0 && team.lineup[0] === previous
      const stillBatting = slot === 0 && team.lineup.some((p, i) => i > 0 && p === previous)
      if (stillPitching) {
        // A two-way player losing his DH spot stays in as the pitcher.
        if (team.fielders[10] === previous) team.fielders[10] = undefined
        team.positions[previous] = 1
      } else if (stillBatting) {
        // A two-way player leaving the mound stays in as the DH.
        if (team.fielders[1] === previous) team.fielders[1] = undefined
      } else {
        // The player leaving this batting slot leaves the game.
        for (let p = 1; p <= 10; p++) if (team.fielders[p] === previous) team.fielders[p] = undefined
        if (kind === "sub") team.removed.push(previous)
      }
      if (a.position === 12) {
        const i = d.bases.findIndex((r) => r?.playerId === previous)
        if (i === -1) return yield* fail(`pinch runner: ${playerName(d, previous)} is not on base`)
        d.bases[i] = { playerId: a.playerId, responsiblePitcherId: d.bases[i]!.responsiblePitcherId }
      }
    } else if (a.position === 12) {
      return yield* fail(`pinch runner: nobody to run for in batting slot ${slot}`)
    }
    // A player can only occupy one batting slot.
    const otherSlot = team.lineup.findIndex((p, i) => p === a.playerId && i !== slot)
    if (otherSlot > 0) {
      return yield* fail(`${playerName(d, a.playerId)} is already batting ${otherSlot}`)
    }
    if (otherSlot === 0) team.lineup[0] = undefined // the pitcher enters the batting order
    team.lineup[slot] = a.playerId
  }
  if (slot !== 0 && a.position === 1 && team.lineup[0] !== undefined && team.lineup[0] !== a.playerId) {
    // The pitcher enters the batting order: the DH is lost.
    const old = team.lineup[0]
    team.lineup[0] = undefined
    if (team.fielders[1] === old) team.fielders[1] = undefined
  }

  // Defensive position.
  const oldPos = team.positions[a.playerId]
  if (oldPos !== undefined && oldPos <= 10 && team.fielders[oldPos] === a.playerId) team.fielders[oldPos] = undefined
  team.positions[a.playerId] = a.position
  if (a.position <= 10) team.fielders[a.position] = a.playerId
  if (a.position === 1 && !team.pitchers.includes(a.playerId)) team.pitchers.push(a.playerId)
  if (!d.batting[a.playerId] && slot !== 0) d.batting[a.playerId] = { ...emptyBattingLine }
  if (a.position === 1 && !d.pitching[a.playerId]) d.pitching[a.playerId] = { ...emptyPitchingLine }
})

// ---------------------------------------------------------------------------
// Half-inning and game-end bookkeeping
// ---------------------------------------------------------------------------

const ensureLineScore = (d: Draft) => {
  const runs = d.lineScore[d.battingSide]
  while (runs.length < d.inning) runs.push(0)
}

const isWalkOff = (d: Draft) =>
  d.battingSide === 1 && d.inning >= d.scheduledInnings && d.score[1] > d.score[0]

const endHalfInning = (d: Draft) => {
  d.leftOnBase[d.battingSide] += d.bases.filter((r) => r !== undefined).length
  d.bases = [undefined, undefined, undefined]
  d.outs = 0
  d.currentCount = undefined
  d.currentPitches = ""
  if (d.battingSide === 0) {
    if (d.inning >= d.scheduledInnings && d.score[1] > d.score[0]) {
      d.phase = "final"
      return
    }
    d.battingSide = 1
  } else {
    if (d.inning >= d.scheduledInnings && d.score[0] !== d.score[1]) {
      d.phase = "final"
      return
    }
    d.battingSide = 0
    d.inning += 1
  }
  ensureLineScore(d)
}

// ---------------------------------------------------------------------------
// Plays
// ---------------------------------------------------------------------------

type Fate = Dest | "out"

interface Movement {
  readonly fates: Map<Origin, Fate>
  /** Origins whose fate was stated explicitly (advance list or runner event). */
  readonly explicit: Set<Origin>
}

const originLabel = (o: Origin) => (o === "B" ? "batter" : `runner on ${baseName(o)}`)

const runnerAt = (bases: Bases, b: Base) => bases[b - 1]

/** Work out where every runner (and the batter) ends up. */
const resolveMovement = Effect.fnUntraced(function*(d: Draft, e: ParsedEvent) {
  const fates = new Map<Origin, Fate>()
  const explicit = new Set<Origin>()
  for (const b of [1, 2, 3] as const) if (runnerAt(d.bases, b)) fates.set(b, b)

  const requireRunner = (b: Base, what: string) =>
    runnerAt(d.bases, b) ? Effect.void : fail(`${what}: there is no runner on ${baseName(b)}`)

  const basic = e.basic
  // The batter's default fate.
  switch (basic._tag) {
    case "FieldedOut":
      fates.set("B", basic.batterOut ? "out" : 1)
      for (const p of basic.putouts) {
        if (p.runner !== "B") {
          yield* requireRunner(p.runner, `putout ${p.fielders}(${p.runner})`)
          fates.set(p.runner, "out")
          explicit.add(p.runner)
        }
      }
      explicit.add("B")
      break
    case "Hit":
      fates.set("B", { Single: 1, Double: 2, GroundRuleDouble: 2, Triple: 3, HomeRun: 4 }[basic.kind] as Dest)
      break
    case "ReachedOnError":
    case "FieldersChoice":
    case "Walk":
    case "HitByPitch":
    case "Interference":
      fates.set("B", 1)
      break
    case "Strikeout":
      fates.set("B", "out")
      break
    case "FoulFlyError":
    case "NoPlay":
    case "RunnerOnly":
      break
  }

  // Baserunning events (alone or after K+ / W+).
  const runnerEvents = basic._tag === "RunnerOnly"
    ? basic.events
    : basic._tag === "Strikeout" || basic._tag === "Walk"
    ? basic.extra
    : []
  for (const r of runnerEvents) {
    switch (r._tag) {
      case "StolenBase":
      case "CaughtStealing":
      case "PickoffCaughtStealing": {
        const from = (r.base - 1) as Base
        yield* requireRunner(from, r._tag === "StolenBase" ? `SB${r.base === 4 ? "H" : r.base}` : "caught stealing")
        fates.set(from, r._tag === "StolenBase" || r.errored ? r.base : "out")
        explicit.add(from)
        break
      }
      case "Pickoff":
        yield* requireRunner(r.base, "pickoff")
        if (!r.errored) {
          fates.set(r.base, "out")
          explicit.add(r.base)
        }
        break
      default:
        break
    }
  }

  // Explicit advances override everything implied.
  for (const a of e.advances) {
    if (a.from === "B") {
      if (!fates.has("B")) return yield* fail(`the batter cannot advance on "${e.raw}" (the at bat is not over)`)
    } else {
      yield* requireRunner(a.from, `advance ${a.from}-${a.to === 4 ? "H" : a.to}`)
    }
    fates.set(a.from, a.out ? "out" : a.to)
    explicit.add(a.from)
  }

  // Implied advances: runners forced by the batter, and everybody on a home run.
  const occupied = new Set<number>()
  for (const [o, f] of fates) if ((o === "B" || explicit.has(o)) && f !== "out" && f !== 4) occupied.add(f)
  const homeRun = basic._tag === "Hit" && basic.kind === "HomeRun"
  for (const b of [1, 2, 3] as const) {
    if (!runnerAt(d.bases, b) || explicit.has(b)) continue
    let dest: number = b
    if (homeRun && fates.get("B") === 4) dest = 4
    while (dest < 4 && occupied.has(dest)) dest++
    fates.set(b, dest as Dest)
    if (dest < 4) occupied.add(dest)
  }

  // Validate the final picture.
  const finalBases = new Map<number, Origin>()
  for (const [o, f] of fates) {
    if (f === "out" || f === 4) continue
    const clash = finalBases.get(f)
    if (clash !== undefined) {
      return yield* fail(`${originLabel(clash)} and ${originLabel(o)} would both end up on ${baseName(f)}`)
    }
    finalBases.set(f, o)
  }
  return { fates, explicit } satisfies Movement
})

const rbiCredited = (
  e: ParsedEvent,
  origin: Origin,
  advance: Advance | undefined,
  forced: boolean,
  outsBefore: number
): boolean => {
  const params = advance?.params ?? []
  if (params.some((p) => p === "NR" || p === "NORBI")) return false
  if (params.includes("RBI")) return true
  if (!endsPlateAppearance(e.basic)) return false
  if (e.modifiers.some((m) => m === "GDP" || m === "BGDP")) return false
  // No RBI when the runner scored on a wild pitch, passed ball or an error on the advance itself.
  if (params.some((p) => p === "WP" || p === "PB" || /E\d/.test(p))) return false
  switch (e.basic._tag) {
    case "ReachedOnError":
      // Modern data marks these (NR) explicitly; older data relies on the rule that
      // there is no RBI on an error with two outs.
      return outsBefore < 2
    case "Strikeout":
      return false
    case "Walk":
      return e.basic.extra.length === 0 || (origin === 3 && forced)
    default:
      return true
  }
}

const applyPlay = Effect.fnUntraced(function*(d: Draft, rec: Extract<RetroRecord, { _tag: "Play" }>) {
  if (d.phase === "final") return yield* fail("the game is over")
  if (rec.inning !== d.inning || rec.side !== d.battingSide) {
    const recHalf = halfPhrase({ inning: rec.inning, battingSide: rec.side })
    return yield* fail(`play is for the ${recHalf}, but the game is in the ${halfPhrase(d)}`)
  }
  const batterId = currentBatterId(d)
  if (batterId === undefined) {
    return yield* fail(`no batter in slot ${d.teams[d.battingSide].nextSlot} of the ${sideName(d.battingSide)} lineup`)
  }
  if (rec.playerId !== batterId) {
    return yield* fail(
      `expected ${playerName(d, batterId)} (${batterId}) to bat, not ${playerName(d, rec.playerId)} (${rec.playerId})`
    )
  }
  const e = yield* parseEvent(rec.event).pipe(
    Effect.mapError((err) => new EngineError({ message: `${err.message} in "${err.event}"` }))
  )
  const { fates } = yield* resolveMovement(d, e)

  const outsMade = [...fates.values()].filter((f) => f === "out").length
  if (d.outs + outsMade > 3) {
    return yield* fail(`play records ${outsMade} out(s) with ${d.outs} already out`)
  }

  d.phase = "in-progress"
  ensureLineScore(d)
  const side = d.battingSide
  const defense = otherSide(side)
  const pitcherId = currentPitcherId(d)
  const basesBefore = structuredClone(d.bases)
  const outsBefore = d.outs
  const endsPa = endsPlateAppearance(e.basic)

  // Move runners.
  const runnerFor = (o: Origin): Runner =>
    o === "B" ? { playerId: batterId, responsiblePitcherId: pitcherId } : runnerAt(d.bases, o)!
  const newBases: [Runner | undefined, Runner | undefined, Runner | undefined] = [undefined, undefined, undefined]
  const scored: Array<string> = []
  const movementText: Array<string> = []
  let rbi = 0
  const walkForced = e.basic._tag === "Walk" && d.bases.every((r) => r !== undefined)
  for (const o of [3, 2, 1, "B"] as const) {
    const fate = fates.get(o)
    if (fate === undefined) continue
    const runner = runnerFor(o)
    const name = playerName(d, runner.playerId)
    if (fate === "out") {
      if (o !== "B" || e.basic._tag !== "Strikeout") movementText.push(`${name} out`)
    } else if (fate === 4) {
      scored.push(runner.playerId)
      movementText.push(`${name} scores`)
      bat(d, runner.playerId, (l) => ({ r: l.r + 1 }))
      pitch(d, runner.responsiblePitcherId, (l) => ({ r: l.r + 1 }))
      if (rbiCredited(e, o, e.advances.find((a) => a.from === o), walkForced, outsBefore)) rbi++
    } else {
      newBases[fate - 1] = runner
      if (o === "B" || fate !== o) movementText.push(`${name} to ${baseName(fate)}`)
    }
  }
  d.bases = newBases
  d.outs += outsMade
  d.score[side] += scored.length
  d.lineScore[side][d.inning - 1]! += scored.length

  // Errors charged to the defense, hits to the offense.
  d.errors[defense] += (e.raw.match(/E[1-9]/g) ?? []).length
  const isHit = e.basic._tag === "Hit"
  if (isHit) d.hits[side] += 1

  // Batter and pitcher statistics.
  for (const r of e.basic._tag === "RunnerOnly" ? e.basic.events : "extra" in e.basic ? e.basic.extra : []) {
    if (r._tag === "StolenBase") {
      const runner = runnerAt(basesBefore, (r.base - 1) as Base)
      if (runner) bat(d, runner.playerId, (l) => ({ sb: l.sb + 1 }))
    } else if ((r._tag === "CaughtStealing" || r._tag === "PickoffCaughtStealing") && !r.errored) {
      const runner = runnerAt(basesBefore, (r.base - 1) as Base)
      if (runner) bat(d, runner.playerId, (l) => ({ cs: l.cs + 1 }))
    } else if (r._tag === "WildPitch") pitch(d, pitcherId, (l) => ({ wp: l.wp + 1 }))
    else if (r._tag === "Balk") pitch(d, pitcherId, (l) => ({ bk: l.bk + 1 }))
  }
  pitch(d, pitcherId, (l) => ({ outs: l.outs + outsMade }))
  if (endsPa) {
    const mods = new Set(e.modifiers.map((m) => m.toUpperCase()))
    const b = e.basic
    const walk = b._tag === "Walk"
    const noAb = walk || b._tag === "HitByPitch" || b._tag === "Interference" || mods.has("SH") || mods.has("SF")
    bat(d, batterId, (l) => ({
      pa: l.pa + 1,
      ab: l.ab + (noAb ? 0 : 1),
      h: l.h + (isHit ? 1 : 0),
      d: l.d + (b._tag === "Hit" && (b.kind === "Double" || b.kind === "GroundRuleDouble") ? 1 : 0),
      t: l.t + (b._tag === "Hit" && b.kind === "Triple" ? 1 : 0),
      hr: l.hr + (b._tag === "Hit" && b.kind === "HomeRun" ? 1 : 0),
      rbi: l.rbi + rbi,
      bb: l.bb + (walk ? 1 : 0),
      ibb: l.ibb + (walk && b.intentional ? 1 : 0),
      so: l.so + (b._tag === "Strikeout" ? 1 : 0),
      hbp: l.hbp + (b._tag === "HitByPitch" ? 1 : 0),
      sh: l.sh + (mods.has("SH") ? 1 : 0),
      sf: l.sf + (mods.has("SF") ? 1 : 0),
      gdp: l.gdp + (mods.has("GDP") ? 1 : 0)
    }))
    pitch(d, pitcherId, (l) => ({
      bf: l.bf + 1,
      h: l.h + (isHit ? 1 : 0),
      hr: l.hr + (b._tag === "Hit" && b.kind === "HomeRun" ? 1 : 0),
      bb: l.bb + (walk ? 1 : 0),
      ibb: l.ibb + (walk && b.intentional ? 1 : 0),
      so: l.so + (b._tag === "Strikeout" ? 1 : 0),
      hbp: l.hbp + (b._tag === "HitByPitch" ? 1 : 0)
    }))
    const team = d.teams[side]
    team.nextSlot = (team.nextSlot % 9) + 1
    d.currentCount = undefined
    d.currentPitches = ""
  } else {
    d.currentCount = rec.count
    d.currentPitches = rec.pitches
  }

  const description = [describeEvent(e), ...movementText].join(". ")
  d.plays.push({
    number: d.plays.length + 1,
    inning: d.inning,
    battingSide: side,
    batterId,
    pitcherId,
    count: rec.count,
    pitches: rec.pitches,
    event: rec.event,
    description,
    outsBefore,
    outsAfter: d.outs,
    basesBefore,
    basesAfter: structuredClone(d.bases),
    runsScored: scored,
    rbi,
    scoreAfter: [d.score[0], d.score[1]]
  })

  if (d.outs === 3) endHalfInning(d)
  else if (isWalkOff(d)) {
    d.phase = "final"
    d.leftOnBase[side] += d.bases.filter((r) => r !== undefined).length
  }
})

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const applyToDraft = Effect.fnUntraced(function*(d: Draft, record: RetroRecord) {
  switch (record._tag) {
    case "Id":
      return yield* fail("id records start a new game and must be handled by the session")
    case "Version":
      d.version = record.version
      return
    case "Info": {
      d.info.push([record.key, record.value])
      if (record.key === "visteam") d.teams[0].code = record.value
      if (record.key === "hometeam") d.teams[1].code = record.value
      if (record.key === "innings") {
        const n = Number(record.value)
        if (Number.isInteger(n) && n > 0) d.scheduledInnings = n
      }
      return
    }
    case "Start":
      return yield* applyAppearance(d, record, "start")
    case "Sub":
      if (d.phase === "final") return yield* fail("the game is over")
      return yield* applyAppearance(d, record, "sub")
    case "Play":
      return yield* applyPlay(d, record)
    case "Comment":
      d.comments.push({ afterPlay: d.plays.length, text: record.text.replace(/^"|"$/g, "") })
      return
    case "Data": {
      if (record.kind === "er") {
        const er = Number(record.value)
        if (!Number.isInteger(er)) return yield* fail(`earned runs must be an integer, got "${record.value}"`)
        pitch(d, record.playerId, () => ({ er }))
      } else {
        d.notes.push(`data ${record.kind} ${record.playerId}: ${record.value}`)
      }
      return
    }
    case "BatterAdj":
      d.notes.push(`${playerName(d, record.playerId)} bats ${record.hand === "L" ? "left" : "right"}-handed`)
      return
    case "PitcherAdj":
      d.notes.push(`${playerName(d, record.playerId)} pitches ${record.hand === "L" ? "left" : "right"}-handed`)
      return
    case "LineupAdj":
      d.teams[record.side].nextSlot = record.slot
      return
    case "RunnerAdj": {
      if (d.phase === "final") return yield* fail("the game is over")
      const player = d.players[record.playerId]
      if (!player || player.side !== d.battingSide) {
        return yield* fail(`${record.playerId} is not a player on the batting team`)
      }
      if (d.bases[record.base - 1]) return yield* fail(`${baseName(record.base)} is already occupied`)
      d.bases[record.base - 1] = { playerId: record.playerId, responsiblePitcherId: currentPitcherId(d) }
      return
    }
    case "PitcherResponsibilityAdj": {
      const runner = d.bases[record.base - 1]
      if (!runner) return yield* fail(`there is no runner on ${baseName(record.base)}`)
      d.bases[record.base - 1] = { ...runner, responsiblePitcherId: record.playerId }
      return
    }
  }
})

/** Apply a record to a game, returning the new state. The input state is never modified. */
export const applyRecord = (game: GameState, record: RetroRecord): Effect.Effect<GameState, EngineError> =>
  Effect.suspend(() => {
    const draft = structuredClone(game) as Draft
    return applyToDraft(draft, record).pipe(Effect.as(draft as GameState))
  })

export const newGame = (gameId: string | undefined): GameState => initialGame(gameId)
