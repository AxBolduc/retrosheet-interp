import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { currentBatterId, currentPitcherId, type GameState } from "../src/retrosheet/Game.ts"
import { Session } from "../src/Session.ts"

const lineup = (side: 0 | 1, prefix: string, dh = true) => [
  ...Array.from({ length: 9 }, (_, i) => {
    const pos = dh ? [8, 6, 9, 10, 3, 5, 7, 2, 4][i]! : [8, 6, 9, 1, 3, 5, 7, 2, 4][i]!
    return `start,${prefix}${i + 1},"${prefix.toUpperCase()} Batter${i + 1}",${side},${i + 1},${pos}`
  }),
  ...(dh ? [`start,${prefix}p,"${prefix.toUpperCase()} Pitcher",${side},0,1`] : [])
]

const header = ["id,HOM202304010", "info,visteam,VIS", "info,hometeam,HOM", ...lineup(0, "v"), ...lineup(1, "h")]

/** Run lines through a fresh session (records or shorthand events), returning the current game. */
const score = (lines: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const session = yield* Session
    for (const line of lines) {
      if (line.includes(",")) yield* session.submitLine(line)
      else yield* session.submitEvent(line)
    }
    return yield* session.currentGame
  }).pipe(Effect.provide(Session.layer))

const runners = (g: GameState) => g.bases.map((r) => r?.playerId ?? null)

describe("Engine", () => {
  it.effect("starts with the visitors' leadoff hitter against the home pitcher", () =>
    Effect.gen(function*() {
      const g = yield* score(header)
      assert.strictEqual(g.phase, "pregame")
      assert.strictEqual(currentBatterId(g), "v1")
      assert.strictEqual(currentPitcherId(g), "hp")
    }))

  it.effect("moves runners and scores runs", () =>
    Effect.gen(function*() {
      const g = yield* score([...header, "S8", "D7.1-3", "HR/F9"])
      assert.deepStrictEqual(g.score, [3, 0])
      assert.deepStrictEqual(runners(g), [null, null, null])
      assert.strictEqual(g.batting["v3"]!.rbi, 3)
      assert.strictEqual(g.batting["v3"]!.hr, 1)
      assert.strictEqual(g.pitching["hp"]!.r, 3)
      assert.strictEqual(currentBatterId(g), "v4")
    }))

  it.effect("forces runners on a walk", () =>
    Effect.gen(function*() {
      const g = yield* score([...header, "W", "W", "W", "W"])
      assert.deepStrictEqual(runners(g), ["v4", "v3", "v2"])
      assert.deepStrictEqual(g.score, [1, 0])
      assert.strictEqual(g.batting["v4"]!.rbi, 1)
      assert.strictEqual(g.batting["v4"]!.ab, 0)
    }))

  it.effect("keeps unforced runners in place", () =>
    Effect.gen(function*() {
      const g = yield* score([...header, "D8", "W"])
      assert.deepStrictEqual(runners(g), ["v2", "v1", null])
    }))

  it.effect("double plays and the end of a half inning", () =>
    Effect.gen(function*() {
      const g = yield* score([...header, "S8", "64(1)3/GDP/G6", "S9"])
      assert.strictEqual(g.outs, 2)
      const g2 = yield* score([...header, "S8", "64(1)3/GDP/G6", "S9", "K"])
      assert.strictEqual(g2.battingSide, 1)
      assert.strictEqual(g2.inning, 1)
      assert.strictEqual(g2.outs, 0)
      assert.deepStrictEqual(g2.leftOnBase, [1, 0])
      assert.strictEqual(currentBatterId(g2), "h1")
      assert.strictEqual(currentPitcherId(g2), "vp")
    }))

  it.effect("runner events keep the same batter up", () =>
    Effect.gen(function*() {
      const g = yield* score([...header, "S8", "SB2", "WP.2-3", "CSH(25)"])
      assert.strictEqual(currentBatterId(g), "v2")
      const g2 = yield* score([...header, "S8", "SB2", "WP.2-3"])
      assert.deepStrictEqual(runners(g2), [null, null, "v1"])
      assert.strictEqual(g2.batting["v1"]!.sb, 1)
      assert.strictEqual(g2.pitching["hp"]!.wp, 1)
    }))

  it.effect("caught stealing for the third out carries the batter over to the next inning", () =>
    Effect.gen(function*() {
      const g = yield* score([...header, "K", "K", "S8", "CS2(24)", "K", "K", "K", "S8"])
      assert.strictEqual(g.inning, 2)
      assert.strictEqual(g.battingSide, 0)
      // v4 was at bat when v3 was caught stealing, so v4 leads off the 2nd... after S8 he's on first.
      assert.deepStrictEqual(runners(g), ["v4", null, null])
    }))

  it.effect("rejects a play by the wrong batter", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(score([...header, "play,1,0,v2,00,X,S8"]))
      assert.isTrue(Exit.isFailure(exit))
    }))

  it.effect("rejects a play in the wrong half inning", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(score([...header, "play,1,1,h1,00,X,S8"]))
      assert.isTrue(Exit.isFailure(exit))
    }))

  it.effect("rejects advancing a runner who isn't there", () =>
    Effect.gen(function*() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(score([...header, "S8.2-H"]))))
      assert.isTrue(Exit.isFailure(yield* Effect.exit(score([...header, "SB2"]))))
    }))

  it.effect("rejects two runners on one base and a fourth out", () =>
    Effect.gen(function*() {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(score([...header, "S8", "S8.1-1"]))))
      assert.isTrue(Exit.isFailure(yield* Effect.exit(score([...header, "S8", "K", "K", "64(1)3"]))))
    }))

  it.effect("pinch hitters and pinch runners", () =>
    Effect.gen(function*() {
      const g = yield* score([
        ...header,
        "S8",
        `sub,vph,"Pinch Hitter",0,2,11`,
        "S9.1-2",
        `sub,vpr,"Pinch Runner",0,2,12`
      ])
      assert.deepStrictEqual(runners(g), ["vpr", "v1", null])
      assert.strictEqual(g.teams[0].lineup[2], "vpr")
      assert.include(g.teams[0].removed, "v2")
      assert.include(g.teams[0].removed, "vph")
      assert.strictEqual(g.batting["vph"]!.h, 1)
    }))

  it.effect("pitching changes and defensive switches", () =>
    Effect.gen(function*() {
      const g = yield* score([
        ...header,
        `sub,hp2,"Reliever",1,0,1`,
        `sub,h1,"H Batter1",1,1,7`,
        `sub,h7,"H Batter7",1,7,8`
      ])
      assert.strictEqual(currentPitcherId(g), "hp2")
      assert.strictEqual(g.teams[1].fielders[7], "h1")
      assert.strictEqual(g.teams[1].fielders[8], "h7")
      assert.include(g.teams[1].removed, "hp")
      assert.deepStrictEqual(g.teams[1].pitchers, ["hp", "hp2"])
    }))

  it.effect("supports a two-way player (DH and pitcher)", () =>
    Effect.gen(function*() {
      const g = yield* score([
        "id,HOM202304010",
        ...lineup(0, "v"),
        ...lineup(1, "h").filter((l) => !l.startsWith("start,hp,")),
        `start,h4,"H Batter4",1,0,1`,
        `sub,hp2,"Reliever",1,0,1`
      ])
      assert.strictEqual(currentPitcherId(g), "hp2")
      assert.strictEqual(g.teams[1].lineup[4], "h4")
      assert.notInclude(g.teams[1].removed, "h4")
    }))

  it.effect("the home team doesn't bat in the 9th when ahead, and walk-offs end the game", () =>
    Effect.gen(function*() {
      const threeUpThreeDown = ["K", "K", "K"]
      const eight = Array.from({ length: 8 }, () => [...threeUpThreeDown, ...threeUpThreeDown]).flat()
      const ahead = yield* score([...header, ...eight, ...threeUpThreeDown, "HR", "K", "K", "K"].slice(0, -4))
      assert.strictEqual(ahead.phase, "in-progress")
      const final = yield* score([...header, ...eight.slice(0, -3), "HR", ...threeUpThreeDown, ...threeUpThreeDown])
      assert.strictEqual(final.phase, "final")
      assert.deepStrictEqual(final.score, [0, 1])
      const walkoff = yield* score([...header, ...eight, ...threeUpThreeDown, "HR"])
      assert.strictEqual(walkoff.phase, "final")
      assert.deepStrictEqual(walkoff.score, [0, 1])
      const after = yield* Effect.exit(score([...header, ...eight, ...threeUpThreeDown, "HR", "K"]))
      assert.isTrue(Exit.isFailure(after))
    }))

  it.effect("places the extra-inning runner with radj", () =>
    Effect.gen(function*() {
      const g = yield* score([...header, "radj,v9,2"])
      assert.deepStrictEqual(runners(g), [null, "v9", null])
    }))
})

describe("Session", () => {
  it.effect("undo restores the previous state", () =>
    Effect.gen(function*() {
      const session = yield* Session
      for (const line of header) yield* session.submitLine(line)
      yield* session.submitEvent("S8")
      yield* session.submitEvent("HR")
      assert.deepStrictEqual((yield* session.currentGame).score, [2, 0])
      assert.deepStrictEqual(yield* session.undo(1), ["play,1,0,v2,??,,HR"])
      const g = yield* session.currentGame
      assert.deepStrictEqual(g.score, [0, 0])
      assert.strictEqual(currentBatterId(g), "v2")
    }).pipe(Effect.provide(Session.layer)))

  it.effect("exports the records of the current game", () =>
    Effect.gen(function*() {
      const session = yield* Session
      for (const line of header) yield* session.submitLine(line)
      yield* session.submitEvent("S8/G6", "BCX", { balls: 1, strikes: 1 })
      const text = yield* session.exportCurrent
      assert.isTrue(text.startsWith("id,HOM202304010\n"))
      assert.isTrue(text.endsWith("play,1,0,v1,11,BCX,S8/G6\n"))
    }).pipe(Effect.provide(Session.layer)))

  it.effect("tracks several games from one file", () =>
    Effect.gen(function*() {
      const session = yield* Session
      const one = [...header, "S8"].map((l) => (l.includes(",") ? l : "play,1,0,v1,??,,S8"))
      const two = one.map((l) => l.replace("HOM202304010", "HOM202304020"))
      const summary = yield* session.loadText([...one, ...two].join("\n"), "test")
      assert.strictEqual(summary.gamesStarted, 2)
      const s = yield* session.state
      assert.strictEqual(s.games.length, 2)
      assert.strictEqual(s.current, 1)
      yield* session.select(0)
      assert.strictEqual((yield* session.currentGame).gameId, "HOM202304010")
    }).pipe(Effect.provide(Session.layer)))
})
