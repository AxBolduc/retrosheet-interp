/**
 * Interactive line input with history and tab completion.
 */
import { Context, Effect, Layer, Option } from "effect"
import * as readline from "node:readline"

export interface LineReaderShape {
  /** Read one line; `None` at end of input. */
  readonly readLine: (prompt: string) => Effect.Effect<Option.Option<string>>
  /** Whether input is an interactive terminal. */
  readonly interactive: boolean
}

export class LineReader extends Context.Service<LineReader, LineReaderShape>()("retrosheet/LineReader") {
  /** A readline-backed reader over stdin/stdout. */
  static readonly layerNode = (completer: (line: string) => ReadonlyArray<string>) =>
    Layer.effect(LineReader)(
      Effect.gen(function*() {
        const interactive = process.stdin.isTTY === true
        const rl = yield* Effect.acquireRelease(
          Effect.sync(() =>
            readline.createInterface({
              input: process.stdin,
              output: interactive ? process.stdout : undefined,
              terminal: interactive,
              historySize: 1000,
              completer: (line: string) => {
                const hits = completer(line)
                return [hits.length > 0 ? [...hits] : [], line]
              }
            })
          ),
          (rl) => Effect.sync(() => rl.close())
        )
        const lines = rl[Symbol.asyncIterator]()
        // Ctrl-C on an empty prompt behaves like end of input.
        rl.on("SIGINT", () => {
          if (rl.line === "") rl.close()
          else rl.write(null, { ctrl: true, name: "u" })
        })
        return {
          interactive,
          readLine: (prompt: string) =>
            Effect.promise(async () => {
              if (interactive) {
                rl.setPrompt(prompt)
                rl.prompt()
              }
              const next = await lines.next()
              return next.done === true ? Option.none() : Option.some(next.value)
            })
        } satisfies LineReaderShape
      })
    )

  /** A reader over a fixed list of lines (for tests and scripts). */
  static readonly layerFromLines = (input: ReadonlyArray<string>) =>
    Layer.sync(LineReader)(() => {
      let i = 0
      return {
        interactive: false,
        readLine: () => Effect.sync(() => (i < input.length ? Option.some(input[i++]!) : Option.none()))
      }
    })
}
