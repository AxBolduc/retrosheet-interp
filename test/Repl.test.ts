import { NodeFileSystem } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { countFromPitches, makeHandler } from "../src/repl/Repl.ts"
import { plainStyle } from "../src/repl/Render.ts"
import { Session } from "../src/Session.ts"

const TestLayer = Layer.mergeAll(Session.layer, NodeFileSystem.layer)

const run = (lines: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const handle = makeHandler(plainStyle)
    const outputs: Array<string> = []
    for (const line of lines) outputs.push((yield* handle(line)).output)
    return outputs
  }).pipe(Effect.provide(TestLayer))

describe("REPL", () => {
  it("derives the count from the pitch sequence", () => {
    assert.deepStrictEqual(countFromPitches("BBCFBX"), { balls: 3, strikes: 2 })
    assert.deepStrictEqual(countFromPitches("CFFFFS"), { balls: 0, strikes: 2 })
    assert.deepStrictEqual(countFromPitches("BBBB"), { balls: 3, strikes: 0 })
    assert.deepStrictEqual(countFromPitches("C1SB>B"), { balls: 1, strikes: 2 })
    assert.strictEqual(countFromPitches(""), undefined)
  })

  it.effect("loads a real game and answers queries", () =>
    Effect.gen(function*() {
      const [load, score, lineup, state, box] = yield* run([
        "load examples/NYA202303300.EVA",
        "score",
        "lineup home",
        "state",
        "box away"
      ])
      assert.include(load, "Loaded 160 records (1 game)")
      assert.match(score!, /SFN\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+4\s+0/)
      assert.match(score!, /NYA\s+1\s+0\s+0\s+2\s+0\s+0\s+2\s+0\s+X\s+5\s+8\s+0/)
      assert.include(lineup, "Aaron Judge")
      assert.include(state, "FINAL")
      assert.match(box!, /Logan Webb\s+6\.0\s+24\s+4\s+4\s+4\s+2\s+12/)
    }))

  it.effect("scores with shorthand, reports errors, and undoes", () =>
    Effect.gen(function*() {
      const out = yield* run([
        "id,TST202301010",
        `start,a1,"Away One",0,1,8`,
        `start,a2,"Away Two",0,2,6`,
        `start,hp,"Home Pitcher",1,1,1`,
        "S8/G BX",
        "SB2",
        "lineup away",
        "play,1,0,a1,00,X,S8",
        "D7.2-H",
        "state",
        "undo",
        "state",
        "explain 64(1)3/GDP",
        "nonsense"
      ])
      assert.include(out[4], "Single to CF")
      assert.include(out[5], "Stolen base")
      assert.include(out[6], "◀ up")
      assert.include(out[7], "expected Away Two (a2) to bat")
      assert.include(out[8], "Away One scores")
      assert.include(out[9], "Visitor 1")
      assert.include(out[10], "undid: play,1,0,a2,??,,D7.2-H")
      assert.include(out[11], "2B: Away One")
      assert.include(out[12], "Double play")
      assert.include(out[13], "unknown command")
    }))
})
