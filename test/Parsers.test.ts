import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { parseEvent } from "../src/retrosheet/Event.ts"
import { formatRecord, parseRecord, splitFields } from "../src/retrosheet/Record.ts"

describe("Record", () => {
  it("splits quoted fields containing commas", () => {
    assert.deepStrictEqual(splitFields(`start,smitj001,"Smith, John",0,1,6`), [
      "start",
      "smitj001",
      "Smith, John",
      "0",
      "1",
      "6"
    ])
  })

  it.effect("parses a play record", () =>
    Effect.gen(function*() {
      const r = yield* parseRecord("play,3,1,judga001,32,BBCFBX,HR/F78XD.2-H;1-H\r")
      assert.strictEqual(r._tag, "Play")
      if (r._tag !== "Play") return
      assert.strictEqual(r.inning, 3)
      assert.strictEqual(r.side, 1)
      assert.deepStrictEqual(r.count, { balls: 3, strikes: 2 })
      assert.strictEqual(r.event, "HR/F78XD.2-H;1-H")
    }))

  it.effect("treats ?? as an unknown count", () =>
    Effect.gen(function*() {
      const r = yield* parseRecord("play,1,0,abc,??,,NP")
      assert.isTrue(r._tag === "Play" && r.count === undefined)
    }))

  it.effect("round-trips records", () =>
    Effect.gen(function*() {
      for (
        const line of [
          `start,wadel001,"LaMonte Wade Jr.",0,1,3`,
          `sub,kahnt001,"Tommy Kahnle",1,0,1`,
          "play,1,0,wadel001,30,BBBB,W",
          "info,visteam,SFN",
          "radj,biggc002,2",
          "ladj,0,4",
          "data,er,webbl001,4"
        ]
      ) {
        assert.strictEqual(formatRecord(yield* parseRecord(line)), line)
      }
    }))

  it.effect("rejects malformed records", () =>
    Effect.gen(function*() {
      for (const line of ["start,abc,\"X\",2,1,6", "start,abc,\"X\",0,10,6", "play,0,0,abc,00,,S8", "foo,bar", "play,1,0"]) {
        const exit = yield* Effect.exit(parseRecord(line))
        assert.isTrue(Exit.isFailure(exit), line)
      }
    }))
})

describe("Event", () => {
  it.effect("parses fielded outs and double plays", () =>
    Effect.gen(function*() {
      const e = yield* parseEvent("64(1)3/GDP/G6")
      assert.strictEqual(e.basic._tag, "FieldedOut")
      if (e.basic._tag !== "FieldedOut") return
      assert.deepStrictEqual(e.basic.putouts, [{ fielders: "64", runner: 1 }, { fielders: "3", runner: "B" }])
      assert.isTrue(e.basic.batterOut)
      assert.deepStrictEqual(e.modifiers, ["GDP", "G6"])
    }))

  it.effect("a force out without a batter putout leaves the batter safe", () =>
    Effect.gen(function*() {
      const e = yield* parseEvent("54(1)/FO/G5")
      assert.isTrue(e.basic._tag === "FieldedOut" && !e.basic.batterOut)
    }))

  it.effect("parses hits, walks, strikeouts and combinations", () =>
    Effect.gen(function*() {
      const tag = (s: string) => Effect.map(parseEvent(s), (e) => e.basic._tag)
      assert.strictEqual(yield* tag("S8/G6M"), "Hit")
      assert.strictEqual(yield* tag("HR/F7"), "Hit")
      assert.strictEqual(yield* tag("H/F7"), "Hit")
      assert.strictEqual(yield* tag("DGR/F9"), "Hit")
      assert.strictEqual(yield* tag("E6/G6"), "ReachedOnError")
      assert.strictEqual(yield* tag("5E3/G5"), "ReachedOnError")
      assert.strictEqual(yield* tag("FC5/G5.3XH(52)"), "FieldersChoice")
      assert.strictEqual(yield* tag("FLE5"), "FoulFlyError")
      assert.strictEqual(yield* tag("C/E2.B-1"), "Interference")
      assert.strictEqual(yield* tag("NP"), "NoPlay")
      assert.strictEqual(yield* tag("SB2;SB3"), "RunnerOnly")
      assert.strictEqual(yield* tag("POCS2(1361)"), "RunnerOnly")
      const k = yield* parseEvent("K+CS2(26)")
      assert.isTrue(k.basic._tag === "Strikeout" && k.basic.extra[0]?._tag === "CaughtStealing")
      const w = yield* parseEvent("IW+WP.2-3")
      assert.isTrue(w.basic._tag === "Walk" && w.basic.intentional && w.basic.extra[0]?._tag === "WildPitch")
    }))

  it.effect("parses advances with parameters", () =>
    Effect.gen(function*() {
      const e = yield* parseEvent("S7/L7D+.2-H(E7/TH)(NR)(UR);1X3(75);B-2")
      assert.deepStrictEqual(
        e.advances.map((a) => [a.from, a.to, a.out]),
        [[2, 4, false], [1, 3, true], ["B", 2, false]]
      )
      assert.deepStrictEqual(e.advances[0]!.params, ["E7/TH", "NR", "UR"])
    }))

  it.effect("negates an X advance only when every fielding sequence has an error", () =>
    Effect.gen(function*() {
      const out = (s: string) => Effect.map(parseEvent(s), (e) => e.advances[0]!.out)
      assert.isFalse(yield* out("S9.1X3(5E3)"))
      assert.isFalse(yield* out("S9.BX1(6E1)"))
      assert.isTrue(yield* out("S5/G56S.BX3(25)(E5/TH)"))
      assert.isTrue(yield* out("FC/G4.1X2(4E6)(6)"))
      assert.isTrue(yield* out("S9.1X3(95)"))
    }))

  it.effect("ignores uncertainty markers", () =>
    Effect.gen(function*() {
      const e = yield* parseEvent("S8#/G!")
      assert.strictEqual(e.basic._tag, "Hit")
    }))

  it.effect("rejects nonsense", () =>
    Effect.gen(function*() {
      for (const s of ["ZZ", "S8.4-5", "S8.1-2;1-3", "S8.2-1", "SB4", "K+XX"]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(parseEvent(s))), s)
      }
    }))
})
