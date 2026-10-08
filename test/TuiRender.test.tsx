import { NodeServices } from "@effect/platform-node"
import type { KeyInput } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { Layer } from "effect"
import { afterEach, assert, describe, it } from "vitest"
import { Session } from "../src/Session.ts"
import { App } from "../src/tui/app/App.tsx"
import { makeScorerStore, type ScorerStore } from "../src/tui/app/store.ts"
import { Scorer } from "../src/tui/Scorer.ts"

type Setup = Awaited<ReturnType<typeof testRender>>

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const f of cleanup.reverse()) await f()
  cleanup = []
})

const mount = async (width = 140, height = 45) => {
  const store: ScorerStore = await makeScorerStore(
    Scorer.layer.pipe(Layer.provideMerge(Session.layer), Layer.provide(NodeServices.layer))
  )
  const ui: Setup = await testRender(<App store={store} autosaveDir={undefined} onQuit={() => {}} />, { width, height })
  cleanup.push(() => store.dispose(), () => ui.renderer.destroy())
  // Scorer updates arrive asynchronously from the Effect runtime, outside act().
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 5))
      await ui.renderOnce()
    }
  }
  const frame = async () => {
    await settle()
    return ui.captureCharFrame()
  }
  const press = async (key: KeyInput, modifiers: { ctrl?: boolean; shift?: boolean } = {}) => {
    ui.mockInput.pressKey(key, modifiers)
    await settle()
  }
  const type = async (text: string) => {
    await ui.mockInput.typeText(text)
    await settle()
  }
  const enter = async (text: string) => {
    await type(text)
    ui.mockInput.pressEnter()
    await settle()
  }
  return { store, ui, frame, press, type, enter }
}

describe("terminal UI", () => {
  it("sets up a game, scores it in the game view and the scorebook", async () => {
    const app = await mount()
    let f = await app.frame()
    assert.include(f, "New game")
    assert.include(f, "Away (bats first)")

    // Starting with an empty form shows what's missing.
    await app.press("g", { ctrl: true })
    f = await app.frame()
    assert.include(f, "Away team code must be 2-4 letters")

    await app.press("e", { ctrl: true })
    await app.press("g", { ctrl: true })
    f = await app.frame()
    assert.include(f, "SFN · Away")
    assert.include(f, "At bat LaMonte Wade")
    assert.include(f, "Wade ▶")

    await app.enter("S8/G")
    // Pitch pad: ball, called strike, swinging strike, then strike three fills in K.
    await app.press("ESCAPE")
    await app.type("bcs")
    f = await app.frame()
    assert.include(f, "Count 1-2")
    await app.type("s")
    f = await app.frame()
    assert.include(f, "› K")
    await app.press("RETURN")
    f = await app.frame()
    assert.include(f, "◆ Wade")
    assert.include(f, "1 out")

    await app.enter("D7/L.1-H")
    f = await app.frame()
    assert.include(f, "Wade scores")
    assert.match(f, /▸SFN\s+1\s+1\s+2\s+0/)

    await app.press("TAB")
    f = await app.frame()
    assert.include(f, "SFN batting")
    assert.include(f, "1B8")
    assert.include(f, "2B7")
    assert.include(f, "▶ at bat")

    await app.press("n", { ctrl: true })
    f = await app.frame()
    assert.include(f, "Substitution")
    await app.press("ESCAPE")

    await app.press("z", { ctrl: true })
    f = await app.frame()
    assert.include(f, "undid: play,1,0,hanim001")
  })

  it("previews events as they are typed", async () => {
    const app = await mount()
    await app.press("e", { ctrl: true })
    await app.press("g", { ctrl: true })
    await app.type("64(1)3/GDP")
    let f = await app.frame()
    assert.include(f, "LaMonte Wade: Double play (SS-2B, 1B)")
    await app.press("RETURN")
    f = await app.frame()
    assert.include(f, "no runner on 1st")
  })
})
