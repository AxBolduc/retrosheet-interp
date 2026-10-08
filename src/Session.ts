/**
 * A scoring session: one or more games built up record by record, with undo.
 */
import { Context, Data, Effect, Layer, Ref } from "effect"
import { applyRecord, EngineError, newGame } from "./retrosheet/Engine.ts"
import { currentBatterId, type GameState } from "./retrosheet/Game.ts"
import { formatRecord, parseRecord, RecordParseError, RetroRecord } from "./retrosheet/Record.ts"

export interface GameEntry {
  readonly state: GameState
  /** The records applied to this game, in order (for saving). */
  readonly records: ReadonlyArray<RetroRecord>
}

export interface SessionState {
  readonly games: ReadonlyArray<GameEntry>
  /** Index of the selected game, or -1 when there are none. */
  readonly current: number
}

interface HistoryEntry {
  readonly label: string
  readonly before: SessionState
}

export class NoGameError extends Data.TaggedError("NoGameError")<{}> {
  override get message() {
    return "no game in progress (enter an id record, e.g. id,NYA202304010, or start a lineup)"
  }
}

export class LoadError extends Data.TaggedError("LoadError")<{
  readonly lineNumber: number
  readonly line: string
  readonly cause: RecordParseError | EngineError
}> {
  override get message() {
    return `line ${this.lineNumber}: ${this.cause.message}\n  > ${this.line}`
  }
}

export interface SubmitResult {
  readonly record: RetroRecord
  readonly before: GameState
  readonly after: GameState
}

export interface LoadSummary {
  readonly records: number
  readonly gamesStarted: number
}

const emptySession: SessionState = { games: [], current: -1 }

const currentEntry = (s: SessionState): GameEntry | undefined => s.games[s.current]

/** Apply one record to a session state (pure). */
const step = (s: SessionState, record: RetroRecord) =>
  Effect.gen(function*() {
    if (record._tag === "Id") {
      const entry: GameEntry = { state: newGame(record.gameId), records: [record] }
      return { games: [...s.games, entry], current: s.games.length } satisfies SessionState
    }
    let entry = currentEntry(s)
    let games = s.games
    let current = s.current
    if (entry === undefined) {
      // Allow scoring without an id record: start an anonymous game.
      entry = { state: newGame(undefined), records: [] }
      games = [...games, entry]
      current = games.length - 1
    }
    const state = yield* applyRecord(entry.state, record)
    const updated: GameEntry = { state, records: [...entry.records, record] }
    return { games: games.map((g, i) => (i === current ? updated : g)), current } satisfies SessionState
  })

const makeSession = Effect.gen(function*() {
  const state = yield* Ref.make(emptySession)
  const history = yield* Ref.make<ReadonlyArray<HistoryEntry>>([])

  const commit = (label: string, before: SessionState, after: SessionState) =>
    Effect.andThen(Ref.set(state, after), Ref.update(history, (h) => [...h, { label, before }]))

  const submitRecord = (record: RetroRecord) =>
    Effect.gen(function*() {
      const before = yield* Ref.get(state)
      const after = yield* step(before, record)
      yield* commit(formatRecord(record), before, after)
      return {
        record,
        before: currentEntry(before)?.state ?? newGame(undefined),
        after: currentEntry(after)!.state
      } satisfies SubmitResult
    })

  const currentGame = Effect.flatMap(Ref.get(state), (s) => {
    const entry = currentEntry(s)
    return entry === undefined ? Effect.fail(new NoGameError()) : Effect.succeed(entry.state)
  })

  return {
    state: Ref.get(state),
    currentGame,

    /** Parse and apply one line of Retrosheet. */
    submitLine: (line: string) => Effect.flatMap(parseRecord(line), submitRecord),

    submitRecord,

    /**
     * Shorthand: score an event for the current batter, filling in inning,
     * team and batter id from the game state.
     */
    submitEvent: (event: string, pitches = "", count: { balls: number; strikes: number } | undefined = undefined) =>
      Effect.gen(function*() {
        const game = yield* currentGame
        const playerId = currentBatterId(game)
        if (playerId === undefined) {
          return yield* new EngineError({ message: "the batting team has no batter in the current lineup slot" })
        }
        return yield* submitRecord(RetroRecord.Play({
          inning: game.inning,
          side: game.battingSide,
          playerId,
          count,
          pitches,
          event
        }))
      }),

    /** Process a whole event file. Records applied before an error are kept (and undoable as one step). */
    loadText: (text: string, label: string) =>
      Effect.gen(function*() {
        const before = yield* Ref.get(state)
        let s = before
        let records = 0
        let gamesStarted = 0
        const lines = text.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (line.trim() === "") continue
          const next = yield* parseRecord(line).pipe(
            Effect.flatMap((record) => step(s, record)),
            Effect.mapError((cause) => new LoadError({ lineNumber: i + 1, line, cause })),
            Effect.tapError(() => commit(`load ${label} (partial)`, before, s))
          )
          if (next.games.length > s.games.length) gamesStarted++
          s = next
          records++
        }
        yield* commit(`load ${label}`, before, s)
        return { records, gamesStarted } satisfies LoadSummary
      }),

    /** Undo the last `n` steps; returns the labels of the undone steps. */
    undo: (n: number) =>
      Effect.gen(function*() {
        const h = yield* Ref.get(history)
        const count = Math.min(n, h.length)
        if (count === 0) return []
        const undone = h.slice(h.length - count)
        yield* Ref.set(state, undone[0]!.before)
        yield* Ref.set(history, h.slice(0, h.length - count))
        return undone.map((u) => u.label).reverse()
      }),

    select: (index: number) =>
      Effect.gen(function*() {
        const s = yield* Ref.get(state)
        if (index < 0 || index >= s.games.length) {
          return yield* Effect.fail(new NoGameError())
        }
        yield* Ref.set(state, { ...s, current: index })
        return s.games[index]!.state
      }),

    /** The current game rendered back to event-file text. */
    exportCurrent: Effect.flatMap(Ref.get(state), (s) => {
      const entry = currentEntry(s)
      return entry === undefined
        ? Effect.fail(new NoGameError())
        : Effect.succeed(entry.records.map(formatRecord).join("\n") + "\n")
    }),

    reset: Effect.andThen(Ref.set(state, emptySession), Ref.set(history, [])),

    /** Forget the undo history, so what's been entered so far can't be undone. */
    clearHistory: Ref.set(history, [])
  }
})

export class Session extends Context.Service<Session, Effect.Success<typeof makeSession>>()("retrosheet/Session") {
  static readonly layer = Layer.effect(Session)(makeSession)
}
