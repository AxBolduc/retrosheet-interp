#!/usr/bin/env node
/**
 * retro-tui — an all-in-one terminal scorebook.
 *
 *   retro-tui                  set up a new game (lineups), then score it
 *   retro-tui game.EVN         resume scoring a game from an event file
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Deferred, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Session } from "../Session.ts"
import { App } from "./app/App.tsx"
import { makeScorerStore } from "./app/store.ts"
import { Scorer } from "./Scorer.ts"

const file = Argument.File("file", { mustExist: true }).pipe(
  Argument.withDescription("a Retrosheet event file to resume"),
  Argument.optional
)

const saveDir = Flag.Directory("save-dir").pipe(
  Flag.withDescription("directory where new games are saved after every play (default: the current directory)"),
  Flag.optional
)

const saveTo = Flag.File("save").pipe(
  Flag.withDescription("save the game to this file after every play (also for a resumed game)"),
  Flag.optional
)

const noSave = Flag.Boolean("no-save").pipe(Flag.withDescription("don't save automatically"), Flag.withDefault(false))

const ScorerLayer = Scorer.layer.pipe(Layer.provideMerge(Session.layer), Layer.provide(NodeServices.layer))

const tui = Command.make("retro-tui", { file, saveDir, saveTo, noSave }, ({ file, saveDir, saveTo, noSave }) =>
  Effect.gen(function*() {
    const store = yield* Effect.promise(() => makeScorerStore(ScorerLayer))
    if (Option.isSome(file)) {
      const outcome = yield* Effect.promise(() => store.run(Scorer.use((s) => s.load(file.value))))
      if (!outcome.ok) {
        yield* Console.error(outcome.output)
        return
      }
    }
    if (!noSave && Option.isSome(saveTo)) yield* Effect.promise(() => store.run(Scorer.use((s) => s.setSavePath(saveTo.value))))

    const done = yield* Deferred.make<void>()
    const renderer = yield* Effect.promise(() => createCliRenderer({ exitOnCtrlC: true, useMouse: true }))
    const quit = () => {
      if (!renderer.isDestroyed) renderer.destroy()
    }
    renderer.on("destroy", () => Deferred.doneUnsafe(done, Effect.void))
    const autosaveDir = noSave || Option.isSome(saveTo) ? undefined : Option.getOrElse(saveDir, () => ".")
    createRoot(renderer).render(<App store={store} autosaveDir={autosaveDir} onQuit={quit} />)
    yield* Deferred.await(done)
    yield* Effect.promise(() => store.dispose())
    const saved = store.getSnapshot().savePath
    if (saved !== undefined) yield* Console.log(`Game saved to ${saved}`)
  })
).pipe(Command.withDescription("Score baseball games in a terminal scorebook, using Retrosheet notation."))

tui.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
