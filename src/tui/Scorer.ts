/**
 * The scorer behind the terminal UI: a {@link Session} plus what the UI needs
 * around it — the pitch-by-pitch buffer for the current plate appearance, a
 * message log, autosave, and shortcuts for substitutions.
 *
 * State is published through a SubscriptionRef so the UI can re-render on change.
 */
import { Context, Effect, FileSystem, Layer, Option, Result, SubscriptionRef } from "effect"
import { classifyLine, makeHandler } from "../repl/Repl.ts"
import { plainStyle } from "../repl/Render.ts"
import { type SessionState, Session } from "../Session.ts"
import { currentBatterId, type GameState, otherSide, playerName } from "../retrosheet/Game.ts"
import { formatRecord, RetroRecord, type Side } from "../retrosheet/Record.ts"
import { isPitchCode } from "./Pitches.ts"
import { type GameSetup, makePlayerId, parsePosition, setupRecords } from "./Setup.ts"

export interface LogLine {
  readonly kind: "input" | "output" | "error"
  readonly text: string
}

export interface ScorerState {
  readonly session: SessionState
  /** Pitches thrown so far in the current plate appearance (not yet recorded). */
  readonly pitches: string
  readonly log: ReadonlyArray<LogLine>
  /** Where the game is saved after every change, if anywhere. */
  readonly savePath: string | undefined
  /** Set when a command asked to leave. */
  readonly quit: boolean
}

export interface Outcome {
  readonly output: string
  readonly ok: boolean
}

export interface Substitution {
  readonly side: Side
  /** Batting order slot 1-9, or 0 for a pitcher who doesn't bat. */
  readonly slot: number
  readonly name: string
  /** 1-10 fielding positions, 11 = pinch hitter, 12 = pinch runner. */
  readonly position: number
}

const MAX_LOG = 500

/** A player on the team by full name, or by last name if only one matches. */
export const findPlayer = (game: GameState, side: Side, name: string): string | undefined => {
  const team = game.teams[side]
  const wanted = name.trim().toLowerCase()
  const exact = team.appeared.find((id) => playerName(game, id).toLowerCase() === wanted || id === wanted)
  if (exact !== undefined) return exact
  const byLast = team.appeared.filter((id) => playerName(game, id).toLowerCase().split(/\s+/).slice(1).join(" ") === wanted)
  return byLast.length === 1 ? byLast[0] : undefined
}

/**
 * Problems with the fielding team's defense: pinch hitters and runners still
 * without a position, or empty positions. Retrosheet expects a `sub` record
 * for each change before the next pitch.
 */
export const defenseIssues = (game: GameState): ReadonlyArray<string> => {
  if (game.phase !== "in-progress") return []
  const side = otherSide(game.battingSide)
  const team = game.teams[side]
  const issues: Array<string> = []
  const label = side === 0 ? "away" : "home"
  for (let slot = 1; slot <= 9; slot++) {
    const id = team.lineup[slot]
    const pos = id === undefined ? undefined : team.positions[id]
    if (id !== undefined && (pos === 11 || pos === 12)) {
      issues.push(`${playerName(game, id)} (${pos === 11 ? "PH" : "PR"}) needs a position: move ${label} ${slot} <pos>, or sub ${label} ${slot} <pos> <name>`)
    }
  }
  const names = ["", "P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]
  const empty = names.flatMap((n, p) => (p > 0 && team.fielders[p] === undefined ? [n] : []))
  if (empty.length > 0 && issues.length === 0) issues.push(`${teamCodeOrSide(game, side)} has nobody at ${empty.join(", ")}`)
  return issues
}

const teamCodeOrSide = (game: GameState, side: Side) => game.teams[side].code ?? (side === 0 ? "Away" : "Home")

export const currentGame = (s: ScorerState): GameState | undefined => s.session.games[s.session.current]?.state

/** Pitches to carry on with after the game changed: those already recorded in this plate appearance. */
const carriedPitches = (game: GameState | undefined) =>
  game === undefined || game.currentPitches === "" ? "" : `${game.currentPitches}.`

const sideArg = (arg: string | undefined): Side | undefined => {
  switch (arg?.toLowerCase()) {
    case "away":
    case "a":
    case "v":
    case "visitor":
    case "0":
      return 0
    case "home":
    case "h":
    case "1":
      return 1
    default:
      return undefined
  }
}

const substitutionPosition = (text: string | undefined): number | undefined => {
  const t = text?.toUpperCase()
  if (t === "PH") return 11
  if (t === "PR") return 12
  return t === undefined ? undefined : parsePosition(t)
}

const usage = {
  ph: "ph <name>  — pinch hitter for the current batter",
  pr: "pr <1|2|3> <name>  — pinch runner for the runner on that base",
  pitcher: "pitcher <name>  — new pitcher for the fielding team",
  sub: "sub <away|home> <slot 0-9> <pos> <name>  — any substitution (pos: P C 1B .. DH PH PR)",
  move: "move <away|home> <slot> <pos>  — move a player to another position"
} as const

const makeScorer = Effect.gen(function*() {
  const session = yield* Session
  const fs = yield* FileSystem.FileSystem
  const context = yield* Effect.context<Session | FileSystem.FileSystem>()
  const handle = makeHandler(plainStyle)
  const ref = yield* SubscriptionRef.make<ScorerState>({
    session: yield* session.state,
    pitches: "",
    log: [],
    savePath: undefined,
    quit: false
  })

  const update = (f: (s: ScorerState) => ScorerState) => SubscriptionRef.update(ref, f)

  const log = (...lines: ReadonlyArray<LogLine>) =>
    update((s) => ({ ...s, log: [...s.log, ...lines.filter((l) => l.text !== "")].slice(-MAX_LOG) }))

  /** Pull the session's state into ours, and save if we're autosaving. */
  const sync = (options: { readonly resetPitches: boolean }) =>
    Effect.gen(function*() {
      const sessionState = yield* session.state
      const game = sessionState.games[sessionState.current]?.state
      yield* update((s) => ({
        ...s,
        session: sessionState,
        pitches: options.resetPitches ? carriedPitches(game) : s.pitches
      }))
      const { savePath } = yield* SubscriptionRef.get(ref)
      if (savePath !== undefined && game !== undefined) {
        const text = yield* Effect.orDie(session.exportCurrent)
        const written = yield* Effect.result(fs.writeFileString(savePath, text))
        if (Result.isFailure(written)) {
          yield* log({ kind: "error", text: `✗ autosave to ${savePath} failed: ${written.failure.message}` })
        }
      }
    })

  /** Run a line through the REPL handler, logging the result. */
  const runLine = (line: string, options: { readonly echo?: string } = {}) =>
    Effect.gen(function*() {
      const before = yield* session.state
      const outcome = yield* handle(line).pipe(Effect.provide(context))
      const ok = !outcome.output.startsWith("✗")
      yield* log({ kind: "input", text: options.echo ?? line }, { kind: ok ? "output" : "error", text: outcome.output })
      const after = yield* session.state
      if (after !== before) {
        const playsBefore = before.games[before.current]?.state.plays.length
        const playsAfter = after.games[after.current]?.state.plays.length
        yield* sync({ resetPitches: playsBefore !== playsAfter || before.current !== after.current })
      }
      if (outcome.quit) yield* update((s) => ({ ...s, quit: true }))
      return { output: outcome.output, ok } satisfies Outcome
    })

  const fail = (line: string, message: string) =>
    Effect.as(log({ kind: "input", text: line }, { kind: "error", text: `✗ ${message}` }), {
      output: `✗ ${message}`,
      ok: false
    } satisfies Outcome)

  const game = Effect.map(SubscriptionRef.get(ref), currentGame)

  const substitute = (sub: Substitution, echo?: string) =>
    Effect.gen(function*() {
      const g = yield* game
      if (g === undefined) return yield* fail(echo ?? "sub", "no game in progress")
      const name = sub.name.trim()
      if (name === "") return yield* fail(echo ?? "sub", "the new player needs a name")
      const existing = findPlayer(g, sub.side, name)
      const playerId = existing ?? makePlayerId(name, new Set(Object.keys(g.players)))
      const record = RetroRecord.Sub({
        playerId,
        name: existing === undefined ? name : playerName(g, existing),
        side: sub.side,
        battingOrder: sub.slot,
        position: sub.position
      })
      return yield* runLine(formatRecord(record), echo === undefined ? {} : { echo })
    })

  /** Substitution shortcuts typed on the command line. */
  const shortcut = (line: string): Effect.Effect<Option.Option<Outcome>> =>
    Effect.gen(function*() {
      const [word = "", ...args] = line.trim().split(/\s+/)
      const g = yield* game
      const some = (e: Effect.Effect<Outcome>) => Effect.map(e, Option.some)
      if (!(word in usage)) return Option.none()
      if (g === undefined) return yield* some(fail(line, "no game in progress"))
      const help = usage[word as keyof typeof usage]
      switch (word) {
        case "ph": {
          if (args.length === 0) return yield* some(fail(line, `usage: ${help}`))
          const team = g.teams[g.battingSide]
          return yield* some(
            substitute({ side: g.battingSide, slot: team.nextSlot, name: args.join(" "), position: 11 }, line)
          )
        }
        case "pr": {
          const base = Number(args[0])
          const runner = base >= 1 && base <= 3 ? g.bases[base - 1] : undefined
          if (args.length < 2 || !(base >= 1 && base <= 3)) return yield* some(fail(line, `usage: ${help}`))
          if (runner === undefined) return yield* some(fail(line, `nobody is on base ${base}`))
          const slot = g.teams[g.battingSide].battingSlots[runner.playerId] ?? 0
          return yield* some(substitute({ side: g.battingSide, slot, name: args.slice(1).join(" "), position: 12 }, line))
        }
        case "pitcher": {
          if (args.length === 0) return yield* some(fail(line, `usage: ${help}`))
          const side = otherSide(g.battingSide)
          const team = g.teams[side]
          const current = team.fielders[1]
          const slot = team.lineup[0] !== undefined ? 0 : current === undefined ? 0 : team.battingSlots[current] ?? 0
          return yield* some(substitute({ side, slot, name: args.join(" "), position: 1 }, line))
        }
        case "sub": {
          const side = sideArg(args[0])
          const slot = Number(args[1])
          const position = substitutionPosition(args[2])
          if (side === undefined || !(slot >= 0 && slot <= 9) || position === undefined || args.length < 4) {
            return yield* some(fail(line, `usage: ${help}`))
          }
          return yield* some(substitute({ side, slot, name: args.slice(3).join(" "), position }, line))
        }
        case "move": {
          const side = sideArg(args[0])
          const slot = Number(args[1])
          const position = substitutionPosition(args[2])
          if (side === undefined || !(slot >= 0 && slot <= 9) || position === undefined) {
            return yield* some(fail(line, `usage: ${help}`))
          }
          const playerId = g.teams[side].lineup[slot]
          if (playerId === undefined) return yield* some(fail(line, `nobody bats ${slot}`))
          return yield* some(substitute({ side, slot, name: playerName(g, playerId), position }, line))
        }
      }
      return Option.none()
    })

  return {
    changes: SubscriptionRef.changes(ref),
    get: SubscriptionRef.get(ref),

    /**
     * Score a line typed by the user: an event (which picks up the buffered
     * pitches unless it gives its own), a record, a command or a shortcut.
     */
    submit: (line: string) =>
      Effect.gen(function*() {
        const short = yield* shortcut(line)
        if (Option.isSome(short)) return short.value
        const input = classifyLine(line)
        const { pitches } = yield* SubscriptionRef.get(ref)
        if (input._tag === "Event" && input.pitches === "" && pitches !== "") {
          return yield* runLine(`${input.event} ${pitches.replace(/\.$/, "")}`, { echo: line })
        }
        return yield* runLine(line)
      }),

    substitute: (sub: Substitution) => substitute(sub),

    /** Start a new game from the setup form. */
    startGame: (setup: GameSetup) =>
      Effect.gen(function*() {
        const records = yield* setupRecords(setup)
        yield* session.reset
        yield* session.loadText(records.map(formatRecord).join("\n"), "lineups")
        yield* session.clearHistory
        yield* log({ kind: "output", text: `Game ${records[0]!._tag === "Id" ? records[0]!.gameId : ""} set up. Play ball!` })
        yield* sync({ resetPitches: true })
      }),

    /** Load an event file to resume a game; the load itself can't be undone. */
    load: (file: string) => Effect.tap(runLine(`load ${file}`), (o) => (o.ok ? session.clearHistory : Effect.void)),

    setSavePath: (savePath: string | undefined) =>
      Effect.andThen(update((s) => ({ ...s, savePath })), sync({ resetPitches: false })),

    /** Save the current game after every change to `<dir>/<gameId>.EVN`, without overwriting an existing file. */
    autosaveTo: (dir: string) =>
      Effect.gen(function*() {
        const g = yield* game
        const stem = `${dir.replace(/\/$/, "")}/${g?.gameId ?? "game"}`
        let savePath = `${stem}.EVN`
        for (let n = 2; yield* Effect.orElseSucceed(fs.exists(savePath), () => false); n++) savePath = `${stem}-${n}.EVN`
        yield* update((s) => ({ ...s, savePath }))
        yield* log({ kind: "output", text: `Saving to ${savePath} after every play.` })
        yield* sync({ resetPitches: false })
        return savePath
      }),

    /** Add a pitch to the current plate appearance; returns the whole sequence so far. */
    addPitch: (code: string) =>
      Effect.map(
        SubscriptionRef.updateAndGet(ref, (s) => (isPitchCode(code) ? { ...s, pitches: s.pitches + code.toUpperCase() } : s)),
        (s) => s.pitches
      ),

    removePitch: update((s) => ({ ...s, pitches: s.pitches.endsWith(".") ? s.pitches : s.pitches.slice(0, -1) })),

    undo: runLine("undo"),

    /** The current batter, for prompts. */
    batter: Effect.map(game, (g) => (g === undefined ? undefined : currentBatterId(g)))
  }
})

export class Scorer extends Context.Service<Scorer, Effect.Success<typeof makeScorer>>()("tui/Scorer") {
  static readonly layer = Layer.effect(Scorer)(makeScorer)
}
