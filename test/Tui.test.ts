import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import { Session } from "../src/Session.ts"
import { currentBatterId, playerName } from "../src/retrosheet/Game.ts"
import { countAfter, impliedEvent, inPlay } from "../src/tui/Pitches.ts"
import { buildScorebook, cellKey, notation } from "../src/tui/Scorebook.ts"
import { currentGame, defenseIssues, findPlayer, Scorer } from "../src/tui/Scorer.ts"
import { emptySetup, exampleSetup, gameIdFor, makePlayerId, parsePosition, setupRecords, validateSetup } from "../src/tui/Setup.ts"
import { pitchCount } from "../src/tui/Stats.ts"

const TestLayer = Scorer.layer.pipe(Layer.provideMerge(Session.layer), Layer.provideMerge(NodeServices.layer))

const started = Effect.gen(function*() {
  const scorer = yield* Scorer
  yield* scorer.startGame(exampleSetup())
  return scorer
})

const game = Scorer.use((s) => Effect.map(s.get, (st) => currentGame(st)!))

describe("Setup", () => {
  it("parses positions by number or name", () => {
    assert.strictEqual(parsePosition("6"), 6)
    assert.strictEqual(parsePosition("ss"), 6)
    assert.strictEqual(parsePosition(" CF "), 8)
    assert.strictEqual(parsePosition("dh"), 10)
    assert.strictEqual(parsePosition("11"), undefined)
    assert.strictEqual(parsePosition("XX"), undefined)
  })

  it("makes Retrosheet-style unique ids", () => {
    assert.strictEqual(makePlayerId("Aaron Judge", new Set()), "judga001")
    assert.strictEqual(makePlayerId("Aaron Judge", new Set(["judga001"])), "judga002")
    assert.strictEqual(makePlayerId("Ichiro", new Set()), "ichi-001")
    assert.strictEqual(makePlayerId("J.D. Davis", new Set()), "davij001")
    assert.strictEqual(makePlayerId("Jose Peña", new Set()), "penaj001")
  })

  it("flags empty names, bad positions and duplicates", () => {
    const issues = validateSetup(emptySetup())
    assert.isTrue(issues.some((i) => i.message.includes("team code")))
    assert.isTrue(issues.some((i) => i.message.includes("needs a name")))
    assert.isTrue(issues.some((i) => i.message.includes("starting pitcher")))
    const s = exampleSetup()
    const dup = {
      ...s,
      teams: [{ ...s.teams[0], lineup: s.teams[0].lineup.map((e, i) => (i === 1 ? { ...e, position: "1B" } : e)) }, s.teams[1]]
    } as const
    assert.isTrue(validateSetup(dup).some((i) => i.message.includes("both play 1B")))
    assert.isTrue(validateSetup({ ...s, useDH: false }).some((i) => i.message.includes("no DH")))
    assert.deepStrictEqual(validateSetup(s), [])
  })

  it.effect("generates records that start a game", () =>
    Effect.gen(function*() {
      const records = yield* setupRecords(exampleSetup())
      assert.strictEqual(gameIdFor(exampleSetup()), "NYA202303300")
      assert.strictEqual(records.filter((r) => r._tag === "Start").length, 20)
      const failed = yield* Effect.result(setupRecords(emptySetup()))
      assert.isTrue(Result.isFailure(failed))
    }))
})

describe("Pitches", () => {
  it("counts balls, strikes and fouls", () => {
    assert.deepStrictEqual(countAfter("BCF"), { balls: 1, strikes: 2 })
    assert.deepStrictEqual(countAfter("CFFFF"), { balls: 0, strikes: 2 })
    assert.deepStrictEqual(countAfter("CFS"), { balls: 0, strikes: 3 })
    assert.deepStrictEqual(countAfter("B.B>B"), { balls: 3, strikes: 0 })
  })

  it("knows when the pitches decide the plate appearance", () => {
    assert.strictEqual(impliedEvent("BBBB"), "W")
    assert.strictEqual(impliedEvent("IIII"), "IW")
    assert.strictEqual(impliedEvent("CSFS"), "K")
    assert.strictEqual(impliedEvent("BH"), "HP")
    assert.strictEqual(impliedEvent("BC"), undefined)
    assert.isTrue(inPlay("BCX"))
    assert.isFalse(inPlay("BC"))
  })
})

describe("Scorebook", () => {
  it("writes plays the way a scorer would", () => {
    assert.deepStrictEqual(notation("64(1)3/GDP"), { text: "6-4-3", tags: ["DP"] })
    assert.deepStrictEqual(notation("63/G"), { text: "6-3", tags: [] })
    assert.deepStrictEqual(notation("8/F"), { text: "F8", tags: [] })
    assert.deepStrictEqual(notation("3/G"), { text: "3U", tags: [] })
    assert.deepStrictEqual(notation("S8/G.1-2"), { text: "1B8", tags: [] })
    assert.deepStrictEqual(notation("K", "CBC"), { text: "Kc", tags: [] })
    assert.deepStrictEqual(notation("9/SF.3-H"), { text: "9", tags: ["SF"] })
    assert.deepStrictEqual(notation("W"), { text: "BB", tags: [] })
    assert.deepStrictEqual(notation("E6"), { text: "E6", tags: [] })
  })

  it.effect("follows batters around the bases", () =>
    Effect.gen(function*() {
      const scorer = yield* Scorer
      yield* scorer.load("examples/NYA202303300.EVA")
      const g = yield* game
      const home = buildScorebook(g, 1)
      // Judge homered in the 1st: scored, with an RBI.
      const judge = home.cells.get(cellKey(2, 0))!
      assert.strictEqual(judge.notation, "HR")
      assert.strictEqual(judge.reached, 4)
      assert.strictEqual(judge.rbi, 1)
      // Rizzo singled after him and was stranded.
      const rizzo = home.cells.get(cellKey(3, 0))!
      assert.strictEqual(rizzo.reached, 1)
      assert.isTrue(rizzo.leftOnBase)
      const away = buildScorebook(g, 0)
      const dp = away.cells.get(cellKey(3, 5))!
      assert.strictEqual(dp.notation, "6-4-3")
      assert.deepStrictEqual(dp.tags, ["DP"])
      // The runner forced at 2nd on that double play was the second out.
      assert.strictEqual(away.cells.get(cellKey(2, 5))!.out, 2)
      assert.strictEqual(home.totals[0]!.runs, 1)
      assert.strictEqual(away.rows[7]!.players.length, 3)
      assert.strictEqual(home.current, undefined)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("adds a column when a team bats around", () =>
    Effect.gen(function*() {
      const scorer = yield* started
      for (let i = 0; i < 9; i++) yield* scorer.submit("W")
      const g = yield* game
      const book = buildScorebook(g, 0)
      assert.deepStrictEqual(book.columns.slice(0, 2), [{ inning: 1, pass: 0 }, { inning: 1, pass: 1 }])
      assert.deepStrictEqual(book.current, { slot: 1, column: 1 })
      assert.strictEqual(book.cells.get(cellKey(1, 0))!.reached, 4)
    }).pipe(Effect.provide(TestLayer)))
})

describe("Scorer", () => {
  it.effect("records buffered pitches with the event, carrying them over runner events", () =>
    Effect.gen(function*() {
      const scorer = yield* started
      yield* scorer.submit("S8/G")
      for (const p of "BC") yield* scorer.addPitch(p)
      const sb = yield* scorer.submit("SB2")
      assert.isTrue(sb.ok)
      assert.strictEqual((yield* scorer.get).pitches, "BC.")
      yield* scorer.addPitch("X")
      yield* scorer.submit("D7/L.2-H")
      const g = yield* game
      const plays = g.plays.slice(-2)
      assert.deepStrictEqual(plays.map((p) => [p.pitches, p.count]), [["BC", { balls: 1, strikes: 1 }], ["BC.X", { balls: 1, strikes: 1 }]])
      assert.strictEqual((yield* scorer.get).pitches, "")
      assert.strictEqual(g.score[0], 1)
      assert.strictEqual(pitchCount(g, "coleg001"), 3)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("handles substitution shortcuts", () =>
    Effect.gen(function*() {
      const scorer = yield* started
      const ph = yield* scorer.submit("ph Brett Wisely")
      assert.isTrue(ph.ok, ph.output)
      let g = yield* game
      assert.strictEqual(playerName(g, currentBatterId(g)), "Brett Wisely")
      yield* scorer.submit("S8")
      const pr = yield* scorer.submit("pr 1 Austin Slater")
      assert.isTrue(pr.ok, pr.output)
      g = yield* game
      assert.strictEqual(playerName(g, g.bases[0]?.playerId), "Austin Slater")
      for (let i = 0; i < 3; i++) yield* scorer.submit("K")
      // The pinch runner is still listed as PR in the field.
      g = yield* game
      assert.isTrue(defenseIssues(g).some((m) => m.includes("Austin Slater (PR)")))
      const move = yield* scorer.submit("move away 1 1B")
      assert.isTrue(move.ok, move.output)
      g = yield* game
      assert.deepStrictEqual(defenseIssues(g), [])
      assert.strictEqual(findPlayer(g, 0, "slater"), g.teams[0].lineup[1])
      // Bottom of the 1st: the away team is in the field.
      const pitcher = yield* scorer.submit("pitcher Tyler Rogers")
      assert.isTrue(pitcher.ok, pitcher.output)
      g = yield* game
      assert.strictEqual(playerName(g, g.teams[0].fielders[1]), "Tyler Rogers")
      assert.strictEqual(g.teams[0].lineup[0], g.teams[0].fielders[1])
      const bad = yield* scorer.submit("sub away 4")
      assert.isFalse(bad.ok)
      assert.include(bad.output, "usage")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("changes pitchers for the fielding team", () =>
    Effect.gen(function*() {
      const scorer = yield* started
      const change = yield* scorer.submit("pitcher Clay Holmes")
      assert.isTrue(change.ok, change.output)
      const g = yield* game
      assert.strictEqual(playerName(g, g.teams[1].fielders[1]), "Clay Holmes")
    }).pipe(Effect.provide(TestLayer)))

  it.effect("undoes plays and restores the pitch buffer", () =>
    Effect.gen(function*() {
      const scorer = yield* started
      yield* scorer.submit("S8")
      yield* scorer.addPitch("B")
      yield* scorer.submit("WP")
      assert.strictEqual((yield* scorer.get).pitches, "B.")
      yield* scorer.undo
      const s = yield* scorer.get
      assert.strictEqual(s.pitches, "")
      assert.strictEqual(currentGame(s)!.plays.length, 1)
      // The lineups themselves can't be undone.
      yield* scorer.undo
      yield* scorer.undo
      const after = yield* scorer.get
      assert.strictEqual(currentGame(after)!.plays.length, 0)
      assert.strictEqual(currentGame(after)!.teams[0].lineup.filter((p) => p !== undefined).length, 10)
    }).pipe(Effect.provide(TestLayer)))
})
