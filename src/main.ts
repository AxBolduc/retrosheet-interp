#!/usr/bin/env node
/**
 * retro — score baseball games in Retrosheet event-file notation.
 *
 *   retro                      start an empty scoring session
 *   retro game.EVN             load a file, then keep scoring interactively
 *   retro game.EVN --report    load a file, print the final state of each game and exit
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { completer, makeHandler, runRepl } from "./repl/Repl.ts"
import { LineReader } from "./repl/LineReader.ts"
import { colorStyle, plainStyle, renderBox, renderLineScore, renderState } from "./repl/Render.ts"
import { Session } from "./Session.ts"

const files = Argument.File("file", { mustExist: true }).pipe(
  Argument.withDescription("Retrosheet event file(s) to load"),
  Argument.variadic()
)

const report = Flag.Boolean("report").pipe(
  Flag.withAlias("r"),
  Flag.withDefault(false),
  Flag.withDescription("print each game's final state (line score, box score) and exit instead of starting the REPL")
)

const noColor = Flag.Boolean("no-color").pipe(Flag.withDescription("disable ANSI colors"), Flag.withDefault(false))

const retro = Command.make("retro", { files, report, noColor }, ({ files, report, noColor }) =>
  Effect.gen(function*() {
    const color = !noColor && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined
    const st = color ? colorStyle : plainStyle
    const handle = makeHandler(st)
    const session = yield* Session

    for (const file of files) {
      const outcome = yield* handle(`load ${file}`)
      if (!report) yield* Console.log(outcome.output)
      else if (outcome.output.includes("✗")) yield* Console.error(outcome.output)
    }

    if (report) {
      const state = yield* session.state
      for (const { state: g } of state.games) {
        yield* Console.log(
          [renderState(g, st), "", renderLineScore(g, st), "", renderBox(g, 0, st), "", renderBox(g, 1, st), ""].join("\n")
        )
      }
      return
    }

    const reader = yield* LineReader
    if (reader.interactive) {
      yield* Console.log(st.dim("Retrosheet scorer — type 'help' for commands, 'help notation' for event syntax."))
    }
    yield* runRepl(st, { echo: !reader.interactive })
  })
).pipe(Command.withDescription("Score baseball games in Retrosheet event-file notation, interactively."))

const MainLayer = Layer.mergeAll(Session.layer, LineReader.layerNode(completer)).pipe(
  Layer.provideMerge(NodeServices.layer)
)

retro.pipe(
  Command.run({ version: "1.0.0" }),
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
