/**
 * The interactive scoring REPL.
 *
 * Input lines are either Retrosheet records (`play,1,0,...`, `sub,...`),
 * shorthand events for the current batter (`S8/G.1-2`), or commands
 * (`state`, `lineup home`, `undo`...).
 */
import { Console, Effect, FileSystem, Option, Result } from "effect"
import { Session, type SubmitResult } from "../Session.ts"
import { describeEvent } from "../retrosheet/Describe.ts"
import { parseEvent } from "../retrosheet/Event.ts"
import { type GameState, halfName, halfPhrase, ordinal, playerName, positionAbbrev, teamCode } from "../retrosheet/Game.ts"
import { type Count, looksLikeRecord, recordKeywords, type Side } from "../retrosheet/Record.ts"
import { LineReader } from "./LineReader.ts"
import {
  renderBox,
  renderDefense,
  renderInfo,
  renderLineScore,
  renderLineup,
  renderPlay,
  renderPlays,
  renderRoster,
  renderSituation,
  renderState,
  type Style
} from "./Render.ts"

export interface ReplOutcome {
  readonly output: string
  readonly quit: boolean
}

const say = (output: string): ReplOutcome => ({ output, quit: false })

interface CommandSpec {
  readonly names: ReadonlyArray<string>
  readonly usage: string
  readonly help: string
}

export const commands: ReadonlyArray<CommandSpec> = [
  { names: ["help", "h", "?"], usage: "help [notation]", help: "show this help, or a Retrosheet notation cheat sheet" },
  { names: ["state", "s", "status"], usage: "state", help: "current inning, outs, runners, batter and pitcher" },
  { names: ["lineup", "l", "lineups"], usage: "lineup [away|home]", help: "batting orders with positions and stats" },
  { names: ["defense", "d", "field"], usage: "defense [away|home]", help: "players at each defensive position" },
  { names: ["score", "linescore", "ls"], usage: "score", help: "line score by inning with R/H/E/LOB" },
  { names: ["box"], usage: "box [away|home]", help: "batting and pitching box score" },
  { names: ["plays", "log", "p"], usage: "plays [n|all]", help: "the last n plays (default 10)" },
  { names: ["roster", "players"], usage: "roster", help: "every player who has appeared, by team" },
  { names: ["info"], usage: "info", help: "info records, comments and notes" },
  { names: ["explain", "x"], usage: "explain <event>", help: "describe an event string without scoring it" },
  { names: ["undo", "u"], usage: "undo [n]", help: "undo the last n entries (a whole loaded file counts as one)" },
  { names: ["load"], usage: "load <file>", help: "read and apply a Retrosheet event file" },
  { names: ["save"], usage: "save <file>", help: "write the current game as a Retrosheet event file" },
  { names: ["records"], usage: "records", help: "print the records of the current game" },
  { names: ["games"], usage: "games", help: "list games in this session" },
  { names: ["game"], usage: "game <n>", help: "switch to game n (see games)" },
  { names: ["quit", "exit", "q"], usage: "quit", help: "leave the REPL" }
]

const commandNames = commands.flatMap((c) => c.names)

const findCommand = (name: string) => commands.find((c) => c.names.includes(name))?.names[0]

const helpText = (st: Style) =>
  [
    st.bold("Scoring"),
    "  Type Retrosheet records exactly as they appear in event files:",
    `    ${st.cyan("id,NYA202304010")}   ${st.cyan("info,visteam,BOS")}   ${st.cyan("start,judga001,\"Aaron Judge\",1,2,9")}`,
    `    ${st.cyan("play,1,0,devera001,12,CBFX,S8/G.1-2")}   ${st.cyan("sub,kahnt001,\"Tommy Kahnle\",1,0,1")}`,
    `  Or just type an event for the current batter, optionally followed by the pitches:`,
    `    ${st.cyan("S8/G.1-2")}   ${st.cyan("K CBFS")}   ${st.cyan("64(1)3/GDP")}   ${st.cyan("SB2")}   ${st.cyan("HR/F7.2-H;1-H BX")}`,
    "",
    st.bold("Commands"),
    ...commands.map((c) => `  ${c.usage.padEnd(22)} ${c.help}`),
    "",
    st.dim("Teams: away/visitor/0/v or home/1/h. Type 'help notation' for event syntax.")
  ].join("\n")

export const notationText = (st: Style) =>
  [
    st.bold("Event syntax:") + " basic[/modifier...][.advance;advance...]",
    "",
    st.bold("Batter events"),
    "  S D T HR   single/double/triple/home run, + fielder: S8, D7, HR9   DGR  ground-rule double",
    "  8  63  543 fielded out; digits are fielders (1=P 2=C 3=1B 4=2B 5=3B 6=SS 7=LF 8=CF 9=RF)",
    "  64(1)3     force at 2nd on runner from 1st (64), then batter out at 1st (3) - double play",
    "  8(B)84(2)  lineout to CF, runner from 2nd doubled off",
    "  E6  5E3    reached on error by SS / throwing error by 3B, error by 1B",
    "  FC6        fielder's choice       K  K23  strikeout (K+WP, K+SB2: strikeout plus another event)",
    "  W  IW  HP  walk, intentional walk, hit by pitch (W+WP, W+SB2...)",
    "  C/E2       catcher's interference FLE5  error on foul fly (at bat continues)",
    "  NP         no play (placeholder before a substitution)",
    "",
    st.bold("Runner events (the batter stays up)"),
    "  SB2 SB3 SBH  stolen base           CS2(24)  caught stealing   PO1(13)  picked off",
    "  POCS2(14)    picked off caught stealing    WP PB BK DI OA  wild pitch, passed ball, balk, def. indifference, other",
    "",
    st.bold("Modifiers"),
    "  /G /L /F /P /BG /BP trajectory + location (/G6, /F78XD)   /SH /SF sacrifice   /GDP /LDP double play  /FO force out",
    "",
    st.bold("Advances"),
    "  .1-2;2-H     runner from 1st to 2nd, runner from 2nd scores    B-2  batter to 2nd",
    "  .2X3(25)     runner from 2nd thrown out at 3rd (C to 3B)        .1X3(5E3)  out negated by error",
    "  (UR) unearned run  (NR) no RBI  (RBI) RBI credited  (E5) advance on error  (WP) (PB)",
    "",
    st.dim("Runners not mentioned stay put, except when forced (walks) or on a home run.")
  ].join("\n")

const parseSide = (arg: string | undefined, game: GameState): Side | "both" | undefined => {
  switch (arg?.toLowerCase()) {
    case undefined:
    case "":
    case "both":
    case "all":
      return "both"
    case "away":
    case "visitor":
    case "visitors":
    case "vis":
    case "v":
    case "0":
      return 0
    case "home":
    case "h":
    case "1":
      return 1
    default:
      if (arg?.toUpperCase() === game.teams[0].code) return 0
      if (arg?.toUpperCase() === game.teams[1].code) return 1
      return undefined
  }
}

const bySide = (game: GameState, arg: string | undefined, f: (side: Side) => string) => {
  const side = parseSide(arg, game)
  if (side === undefined) return `unknown team "${arg}" (use away or home)`
  return side === "both" ? `${f(0)}\n\n${f(1)}` : f(side)
}

const balls = new Set(["B", "I", "P", "V", "H"])
const strikes = new Set(["C", "S", "K", "M", "O", "Q", "T"])
const fouls = new Set(["F", "L", "R"])

/** The count before the final pitch of a pitch sequence (the count Retrosheet records). */
export const countFromPitches = (pitches: string): Count | undefined => {
  const p = pitches.replace(/[^A-Z]/gi, "").toUpperCase()
  if (p === "" || p.includes("U")) return undefined
  let b = 0
  let s = 0
  for (const ch of p.slice(0, -1)) {
    if (balls.has(ch)) b = Math.min(3, b + 1)
    else if (strikes.has(ch)) s = Math.min(2, s + 1)
    else if (fouls.has(ch) && s < 2) s++
  }
  return { balls: b, strikes: s }
}

/** Narrate what a submitted record did. */
const narrate = (r: SubmitResult, st: Style): string => {
  const { record, before, after } = r
  switch (record._tag) {
    case "Id":
      return st.green(`New game ${record.gameId}.`)
    case "Start":
    case "Sub": {
      const team = teamCode(after, record.side)
      const slot = record.battingOrder === 0 ? "not batting" : `batting ${ordinal(record.battingOrder)}`
      const pos = positionAbbrev(record.position)
      if (record._tag === "Start") return st.dim(`${team}: ${record.name} ${slot}, ${pos}`)
      const replaced = before.teams[record.side].lineup[record.battingOrder]
      const verb = replaced === record.playerId
        ? `${record.name} moves to ${pos}`
        : `${record.name} replaces ${playerName(before, replaced)}, ${slot}, ${pos}`
      return st.yellow(`${team} change: ${verb}`)
    }
    case "Play": {
      const lines: Array<string> = []
      const play = after.plays.length > before.plays.length ? after.plays[after.plays.length - 1] : undefined
      if (play) lines.push(renderPlay(after, play, st))
      const halfChanged = after.inning !== before.inning || after.battingSide !== before.battingSide
      if (halfChanged || after.phase === "final") {
        lines.push(st.bold(`End of the ${halfPhrase(before)}: ${
          teamCode(after, 0)
        } ${after.score[0]}, ${teamCode(after, 1)} ${after.score[1]}`))
      }
      lines.push(renderSituation(after, st))
      return lines.join("\n")
    }
    case "Info":
    case "Version":
    case "Comment":
    case "Data":
      return ""
    default:
      return st.dim("ok")
  }
}

export const makeHandler = (st: Style) => {
  const errorText = (e: { readonly message: string }) => st.red(`✗ ${e.message}`)

  const withGame = (f: (game: GameState) => string) =>
    Effect.gen(function*() {
      const session = yield* Session
      const game = yield* Effect.result(session.currentGame)
      return say(Result.isFailure(game) ? errorText(game.failure) : f(game.success))
    })

  const runCommand = Effect.fnUntraced(function*(name: string, args: ReadonlyArray<string>) {
    const session = yield* Session
    const fs = yield* FileSystem.FileSystem
    switch (name) {
      case "help":
        return say(args[0]?.startsWith("not") ? notationText(st) : helpText(st))
      case "quit":
        return { output: "", quit: true }
      case "state":
        return yield* withGame((g) => renderState(g, st))
      case "lineup":
        return yield* withGame((g) => bySide(g, args[0], (side) => renderLineup(g, side, st)))
      case "defense":
        return yield* withGame((g) => bySide(g, args[0], (side) => renderDefense(g, side, st)))
      case "score":
        return yield* withGame((g) => `${renderLineScore(g, st)}\n${renderSituation(g, st)}`)
      case "box":
        return yield* withGame((g) => bySide(g, args[0], (side) => renderBox(g, side, st)))
      case "plays": {
        const n = args[0] === "all" ? Infinity : args[0] === undefined ? 10 : Number(args[0])
        if (!(n > 0)) return say(errorText({ message: "usage: plays [n|all]" }))
        return yield* withGame((g) => renderPlays(g, n, st))
      }
      case "roster":
        return yield* withGame((g) => renderRoster(g, st))
      case "info":
        return yield* withGame((g) => renderInfo(g, st))
      case "explain": {
        if (args.length === 0) return say(errorText({ message: "usage: explain <event>" }))
        const result = yield* Effect.result(parseEvent(args.join("")))
        if (Result.isFailure(result)) return say(errorText(result.failure))
        const e = result.success
        const adv = e.advances.map((a) =>
          `${a.from === "B" ? "batter" : `runner on ${a.from}`} ${a.out ? "out at" : a.attemptedOut ? "safe (error) at" : "to"} ${
            a.to === 4 ? "home" : a.to
          }${a.params.length ? ` (${a.params.join(", ")})` : ""}`
        )
        return say([describeEvent(e), ...adv.map((a) => `  ${a}`)].join("\n"))
      }
      case "undo": {
        const n = args[0] === undefined ? 1 : Number(args[0])
        if (!(n > 0)) return say(errorText({ message: "usage: undo [n]" }))
        const undone = yield* session.undo(n)
        if (undone.length === 0) return say(st.dim("Nothing to undo."))
        const game = yield* Effect.option(session.currentGame)
        return say(
          [...undone.map((u) => st.yellow(`undid: ${u}`)), ...Option.toArray(Option.map(game, (g) => renderSituation(g, st)))]
            .join("\n")
        )
      }
      case "load": {
        const file = args.join(" ")
        if (file === "") return say(errorText({ message: "usage: load <file>" }))
        const text = yield* Effect.result(fs.readFileString(file))
        if (Result.isFailure(text)) return say(errorText({ message: `cannot read ${file}: ${text.failure.message}` }))
        const loaded = yield* Effect.result(session.loadText(text.success, file))
        const game = yield* Effect.option(session.currentGame)
        const situation = Option.match(game, { onNone: () => "", onSome: (g) => `\n${renderSituation(g, st)}` })
        if (Result.isFailure(loaded)) {
          return say(`${errorText(loaded.failure)}\n${st.dim("Records before the error were applied.")}${situation}`)
        }
        const { records, gamesStarted } = loaded.success
        return say(
          st.green(`Loaded ${records} records${gamesStarted > 0 ? ` (${gamesStarted} game${gamesStarted > 1 ? "s" : ""})` : ""} from ${file}.`) +
            situation
        )
      }
      case "save": {
        const file = args.join(" ")
        if (file === "") return say(errorText({ message: "usage: save <file>" }))
        const text = yield* Effect.result(session.exportCurrent)
        if (Result.isFailure(text)) return say(errorText(text.failure))
        const written = yield* Effect.result(fs.writeFileString(file, text.success))
        if (Result.isFailure(written)) return say(errorText({ message: `cannot write ${file}: ${written.failure.message}` }))
        return say(st.green(`Saved ${text.success.trimEnd().split("\n").length} records to ${file}.`))
      }
      case "records": {
        const text = yield* Effect.result(session.exportCurrent)
        return say(Result.isFailure(text) ? errorText(text.failure) : text.success.trimEnd())
      }
      case "games": {
        const s = yield* session.state
        if (s.games.length === 0) return say(st.dim("No games yet."))
        return say(
          s.games.map((g, i) => {
            const marker = i === s.current ? st.yellow("▶") : " "
            const gs = g.state
            const status = gs.phase === "final" ? "final" : gs.phase === "pregame" ? "pregame" : halfName(gs)
            return `${marker} ${String(i + 1).padStart(3)}  ${(gs.gameId ?? "(no id)").padEnd(14)} ${teamCode(gs, 0)} ${gs.score[0]} @ ${
              teamCode(gs, 1)
            } ${gs.score[1]}  ${st.dim(status)}`
          }).join("\n")
        )
      }
      case "game": {
        const n = Number(args[0])
        const selected = yield* Effect.result(session.select(n - 1))
        if (Result.isFailure(selected)) return say(errorText({ message: `no game ${args[0] ?? ""} (see games)` }))
        return say(renderState(selected.success, st))
      }
      default:
        return say(errorText({ message: `unknown command ${name}` }))
    }
  })

  /** Handle one line of input. */
  return Effect.fnUntraced(function*(rawLine: string) {
    const input = classifyLine(rawLine)
    const session = yield* Session
    switch (input._tag) {
      case "Empty":
        return say("")
      case "Record": {
        const result = yield* Effect.result(session.submitLine(input.line))
        return say(Result.isFailure(result) ? errorText(result.failure) : narrate(result.success, st))
      }
      case "Command":
        return yield* runCommand(input.name, input.args)
      case "Event": {
        const result = yield* Effect.result(session.submitEvent(input.event, input.pitches, countFromPitches(input.pitches)))
        return say(Result.isFailure(result) ? errorText(result.failure) : narrate(result.success, st))
      }
      case "Unknown":
        return say(errorText({ message: `unknown command or record "${input.word}" (type help)` }))
    }
  })
}

/** What a line of input is. */
export type InputLine =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Record"; readonly line: string }
  | { readonly _tag: "Command"; readonly name: string; readonly args: ReadonlyArray<string> }
  /** Shorthand event for the current batter: `EVENT [pitches]`. */
  | { readonly _tag: "Event"; readonly event: string; readonly pitches: string }
  | { readonly _tag: "Unknown"; readonly word: string }

export const classifyLine = (rawLine: string): InputLine => {
  const line = rawLine.trim()
  if (line === "" || line.startsWith("#")) return { _tag: "Empty" }
  if (looksLikeRecord(line)) return { _tag: "Record", line }
  const [first = "", ...rest] = line.replace(/^[:.]/, "").split(/\s+/)
  const command = findCommand(first.toLowerCase())
  if (command !== undefined && (first === first.toLowerCase() || line.startsWith(":"))) {
    return { _tag: "Command", name: command, args: rest }
  }
  if (/^[A-Z0-9]/.test(first)) return { _tag: "Event", event: first, pitches: rest[0] ?? "" }
  return { _tag: "Unknown", word: first }
}

/** Tab completion: commands, record keywords and player ids. */
export const completer = (line: string): ReadonlyArray<string> => {
  if (line.includes(" ") || line.includes(",")) return []
  return [...commandNames, ...recordKeywords.map((k) => `${k},`)].filter((c) => c.startsWith(line))
}

/** Run the read-eval-print loop until `quit` or end of input. */
export const runRepl = (st: Style, options: { readonly echo: boolean }) =>
  Effect.gen(function*() {
    const reader = yield* LineReader
    const session = yield* Session
    const handle = makeHandler(st)
    while (true) {
      const game = yield* Effect.option(session.currentGame)
      const prompt = Option.match(game, {
        onNone: () => "retro> ",
        onSome: (g) =>
          g.phase === "final"
            ? "final> "
            : g.phase === "pregame"
            ? `${g.gameId ?? "game"}> `
            : `${g.battingSide === 0 ? "T" : "B"}${g.inning} ${g.outs}o> `
      })
      const input = yield* reader.readLine(st.cyan(prompt))
      if (Option.isNone(input)) break
      if (options.echo && input.value.trim() !== "") yield* Console.log(`${prompt}${input.value}`)
      const outcome = yield* handle(input.value)
      if (outcome.output !== "") yield* Console.log(outcome.output)
      if (outcome.quit) break
    }
  })
