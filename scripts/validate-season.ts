/**
 * Replays every game in a directory of Retrosheet event files and checks
 * the final score against a Retrosheet game log.
 *
 * Usage: tsx scripts/validate-season.ts <events-dir> <gamelog.txt>
 */
import { NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Path } from "effect"
import { Session } from "../src/Session.ts"
import { splitFields } from "../src/retrosheet/Record.ts"

const program = Effect.gen(function*() {
  const args = process.argv.slice(2).filter((a) => a !== "--verbose")
  const verbose = process.argv.includes("--verbose")
  const [eventsDir, gameLog] = args
  if (eventsDir === undefined || gameLog === undefined) {
    return yield* Console.error("usage: validate-season <events-dir> <gamelog.txt>")
  }
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const session = yield* Session

  const expected = new Map<string, ReadonlyArray<string>>()
  for (const line of (yield* fs.readFileString(gameLog)).split(/\r?\n/)) {
    if (line.trim() === "") continue
    const f = splitFields(line)
    expected.set(`${f[6]}${f[0]}${f[1]}`, f)
  }
  // Team stat columns in the game log (0-based, visitor; home is +28).
  const statColumns = { h: 22, hr: 25, rbi: 26, bb: 30, so: 32, sb: 33, lob: 37, e: 45 } as const
  const statMismatches: Record<string, number> = {}

  const files = (yield* fs.readDirectory(eventsDir)).filter((f) => /\.EV[AN]$/i.test(f)).sort()
  let games = 0
  let matched = 0
  const failures: Array<string> = []
  for (const file of files) {
    yield* session.reset
    const text = yield* fs.readFileString(path.join(eventsDir, file))
    const result = yield* Effect.result(session.loadText(text, file))
    const state = yield* session.state
    if (result._tag === "Failure") failures.push(`${file}: ${result.failure.message}`)
    const completed = result._tag === "Failure" ? state.games.slice(0, -1) : state.games
    for (const g of completed) {
      games++
      const log = expected.get(g.state.gameId ?? "")
      const got = g.state.score
      const exp = log === undefined ? undefined : [Number(log[9]), Number(log[10])]
      if (exp && exp[0] === got[0] && exp[1] === got[1]) matched++
      else failures.push(`${g.state.gameId}: expected ${exp?.join("-")}, got ${got.join("-")} (${g.state.phase})`)
      if (log === undefined) continue
      for (const side of [0, 1] as const) {
        const ids = g.state.teams[side].appeared
        const sum = (k: "h" | "hr" | "rbi" | "bb" | "so" | "sb") =>
          ids.reduce((n, id) => n + (g.state.batting[id]?.[k] ?? 0), 0)
        const actual = {
          h: sum("h"),
          hr: sum("hr"),
          rbi: sum("rbi"),
          bb: sum("bb"),
          so: sum("so"),
          sb: sum("sb"),
          // A game called mid-inning strands the runners still on base.
          lob: g.state.leftOnBase[side] +
            (g.state.phase !== "final" && g.state.battingSide === side
              ? g.state.bases.filter((r) => r !== undefined).length
              : 0),
          e: g.state.errors[side === 0 ? 0 : 1]
        }
        for (const [k, col] of Object.entries(statColumns)) {
          // Errors are charged to the fielding team, which is the same team's defensive columns.
          const want = Number(log[col + side * 28])
          if (actual[k as keyof typeof actual] !== want) {
            statMismatches[k] = (statMismatches[k] ?? 0) + 1
            if (verbose) failures.push(`${g.state.gameId} ${side === 0 ? "vis" : "home"} ${k}: expected ${want}, got ${actual[k as keyof typeof actual]}`)
          }
        }
      }
    }
  }
  for (const f of failures.slice(0, 40)) yield* Console.log(f)
  yield* Console.log(`\nteam stat mismatches (team-games): ${JSON.stringify(statMismatches)}`)
  yield* Console.log(`${matched}/${games} games match the game log; ${failures.length} problems`)
})

program.pipe(
  Effect.provide(Layer.mergeAll(Session.layer, NodeFileSystem.layer, NodePath.layer)),
  NodeRuntime.runMain
)
