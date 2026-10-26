/**
 * The scoring screen: line score on top, the game or scorebook view in the
 * middle, and the command bar at the bottom where plays are entered in
 * Retrosheet notation (with an optional pitch-by-pitch pad).
 */
import type { KeyEvent, ScrollBoxRenderable, SubmitEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { Effect, Result } from "effect"
import { useMemo, useRef, useState } from "react"
import { classifyLine, commands, notationText } from "../../repl/Repl.ts"
import { plainStyle } from "../../repl/Render.ts"
import { describeEvent } from "../../retrosheet/Describe.ts"
import { parseEvent } from "../../retrosheet/Event.ts"
import { currentBatterId, type GameState, otherSide, playerName, positionAbbrev, teamCode } from "../../retrosheet/Game.ts"
import type { Side } from "../../retrosheet/Record.ts"
import { countAfter, impliedEvent, inPlay, isPitchCode, pitchCodes } from "../Pitches.ts"
import { currentGame, defenseIssues, findRosterPlayer, Scorer, type ScorerState } from "../Scorer.ts"
import { parsePosition, type RosterPlayer } from "../Setup.ts"
import { GameView } from "./GameView.tsx"
import { Scoreboard } from "./Scoreboard.tsx"
import { ScorebookView } from "./ScorebookView.tsx"
import type { ScorerStore } from "./store.ts"
import { theme } from "./theme.ts"

type View = "game" | "scorebook"
type BookSide = "auto" | Side
type Mode = "event" | "pitch"
type Modal =
  | { readonly _tag: "Help" }
  | { readonly _tag: "Output"; readonly title: string; readonly text: string }
  | { readonly _tag: "Sub" }

/** What the line being typed would do, shown under the input. */
export const previewLine = (line: string, game: GameState | undefined): { readonly text: string; readonly error: boolean } => {
  const input = classifyLine(line)
  switch (input._tag) {
    case "Empty":
      return { text: "", error: false }
    case "Record":
      return { text: "Retrosheet record", error: false }
    case "Command": {
      const spec = commands.find((c) => c.names[0] === input.name)
      return { text: spec === undefined ? "" : `${spec.usage} — ${spec.help}`, error: false }
    }
    case "Event": {
      const parsed = Effect.runSync(Effect.result(parseEvent(input.event)))
      if (Result.isFailure(parsed)) return { text: parsed.failure.message, error: true }
      const batter = game === undefined ? "" : `${playerName(game, currentBatterId(game))}: `
      return { text: `${batter}${describeEvent(parsed.success)}`, error: false }
    }
    case "Unknown": {
      const word = input.word.toLowerCase()
      const shortcuts: Record<string, string> = {
        ph: "ph <name> — pinch hitter for the current batter",
        pr: "pr <base> <name> — pinch runner",
        pitcher: "pitcher <name> — pitching change",
        sub: "sub <away|home> <slot> <pos> <name> — substitution",
        move: "move <away|home> <slot> <pos> — position change"
      }
      return { text: shortcuts[word] ?? `unknown command "${input.word}" — events start with a capital letter or digit`, error: !(word in shortcuts) }
    }
  }
}

const keyHelp: ReadonlyArray<readonly [string, string]> = [
  ["Tab", "switch between the game view and the scorebook"],
  ["Ctrl+T", "scorebook: batting team / away / home"],
  ["Esc", "switch between typing events and the pitch pad"],
  ["Ctrl+N", "substitution"],
  ["Ctrl+Z", "undo the last entry"],
  ["Ctrl+L", "show the full log"],
  ["PgUp/PgDn", "scroll the scorebook"],
  ["F1", "this help"],
  ["Ctrl+C", "quit (the game is saved as you go)"]
]

const helpText = () =>
  [
    "KEYS",
    ...keyHelp.map(([k, v]) => `  ${k.padEnd(9)} ${v}`),
    "",
    "PITCH PAD (Esc to toggle)",
    `  ${pitchCodes.slice(0, 12).map(([c, d]) => `${c} ${d}`).join(" · ")}`,
    "  Backspace removes the last pitch; ball four, strike three and HBP fill in the event; X (in play) asks for it.",
    "  Events you type pick up the pitches automatically.",
    "",
    "SUBSTITUTIONS",
    "  ph <name>                          pinch hitter for the current batter",
    "  pr <1|2|3> <name>                  pinch runner",
    "  pitcher <name>                     new pitcher for the fielding team",
    "  sub <away|home> <slot> <pos> <name>  any substitution (slot 0 = pitcher not batting)",
    "  move <away|home> <slot> <pos>      position change",
    "  or Ctrl+N for a form. Raw sub/start/play/info records work too.",
    "",
    "COMMANDS",
    ...commands.map((c) => `  ${c.usage.padEnd(22)} ${c.help}`),
    "",
    notationText(plainStyle)
  ].join("\n")

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

const Overlay = (
  { title, width, height, children, footer }: {
    readonly title: string
    readonly width: number
    readonly height: number
    readonly children: React.ReactNode
    readonly footer: string
  }
) => {
  const dims = useTerminalDimensions()
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((dims.width - width) / 2))}
      top={Math.max(0, Math.floor((dims.height - height) / 2))}
      width={width}
      height={height}
      zIndex={100}
      border
      borderStyle="rounded"
      borderColor={theme.borderFocus}
      backgroundColor={theme.panel}
      title={` ${title} `}
      titleColor={theme.accent}
      bottomTitle={` ${footer} `}
      bottomTitleAlignment="right"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {children}
    </box>
  )
}

const TextOverlay = ({ title, text }: { readonly title: string; readonly text: string }) => {
  const dims = useTerminalDimensions()
  const lines = text.split("\n")
  const width = Math.min(dims.width - 4, Math.max(40, ...lines.map((l) => l.length + 6)))
  const height = Math.min(dims.height - 2, lines.length + 3)
  return (
    <Overlay title={title} width={width} height={height} footer="↑↓ PgUp PgDn scroll · Esc close">
      <scrollbox focused flexGrow={1} backgroundColor={theme.panel} scrollY>
        {lines.map((line, i) => <text key={i} fg={theme.text} height={1}>{line === "" ? " " : line}</text>)}
      </scrollbox>
    </Overlay>
  )
}

interface SubForm {
  readonly side: Side
  readonly slot: string
  readonly position: string
  readonly name: string
}

const subPosition = (text: string) => {
  const t = text.trim().toUpperCase()
  return t === "PH" ? 11 : t === "PR" ? 12 : parsePosition(t)
}

const SubDialog = (
  { game, roster, form, field, onChange, error }: {
    readonly game: GameState
    /** The team's roster for the game, if known. */
    readonly roster: ReadonlyArray<RosterPlayer>
    readonly form: SubForm
    readonly field: number
    readonly onChange: (f: (form: SubForm) => SubForm) => void
    readonly error: string | undefined
  }
) => {
  const team = game.teams[form.side]
  const slot = Number(form.slot)
  const occupant = Number.isInteger(slot) && slot >= 0 && slot <= 9 ? team.lineup[slot] : undefined
  const pos = subPosition(form.position)
  const appeared = new Set(team.appeared.map((id) => playerName(game, id)))
  const available = roster.filter((p) => !appeared.has(p.name) && p.role !== "lineup" && p.role !== "starter")
  const match = findRosterPlayer(roster, form.name)
  const pitching = pos === 1
  const hint = form.name.trim() !== ""
    ? match === undefined
      ? "Not on the roster: a new player by that name."
      : `→ ${match.name} (${match.position}${match.jersey === "" ? "" : `, #${match.jersey}`})`
    : available.length === 0
    ? ""
    : `${pitching ? "Bullpen" : "Bench"}: ${
      available
        .filter((p) => (p.role === "bullpen") === pitching)
        .map((p) => p.name.split(/\s+/).slice(1).join(" ") || p.name)
        .join(", ")
    }`
  const label = (i: number, text: string) => (
    <text width={10} fg={field === i ? theme.accent : theme.dim}>{text}</text>
  )
  const inputProps = (i: number) => ({
    focused: field === i,
    backgroundColor: theme.inputBg,
    focusedBackgroundColor: theme.inputFocusBg,
    textColor: theme.text,
    focusedTextColor: theme.text
  })
  return (
    <Overlay title="Substitution" width={72} height={roster.length === 0 ? 13 : 15} footer="Tab next · ←→ team · Enter submit · Esc cancel">
      <box flexDirection="row" height={1}>
        {label(0, "Team")}
        {([0, 1] as const).map((s) => (
          <text key={s} fg={form.side === s ? theme.bg : theme.text} bg={form.side === s ? (field === 0 ? theme.accent : theme.dim) : theme.panel}>
            {` ${teamCode(game, s)} (${s === 0 ? "away" : "home"}) `}
          </text>
        ))}
      </box>
      <box flexDirection="row" height={1} marginTop={1}>
        {label(1, "Slot")}
        <input width={4} value={form.slot} onInput={(v) => onChange((f) => ({ ...f, slot: v }))} {...inputProps(1)} />
        <text fg={theme.dim}>{`  0 = pitcher not batting · now: ${occupant === undefined ? "—" : playerName(game, occupant)}`}</text>
      </box>
      <box flexDirection="row" height={1} marginTop={1}>
        {label(2, "Position")}
        <input width={5} value={form.position} onInput={(v) => onChange((f) => ({ ...f, position: v }))} {...inputProps(2)} />
        <text fg={pos === undefined ? theme.red : theme.dim}>
          {pos === undefined ? "  P C 1B 2B 3B SS LF CF RF DH PH PR" : `  ${positionAbbrev(pos)}`}
        </text>
      </box>
      <box flexDirection="row" height={1} marginTop={1}>
        {label(3, "Player")}
        <input width={36} value={form.name} placeholder={roster.length === 0 ? "player name" : "name, or just the last name"} onInput={(v) => onChange((f) => ({ ...f, name: v }))} {...inputProps(3)} />
      </box>
      {roster.length > 0 && (
        <text marginTop={1} height={1} fg={match === undefined && form.name.trim() !== "" ? theme.orange : theme.dim}>
          {hint.length > 66 ? `${hint.slice(0, 65)}…` : hint}
        </text>
      )}
      <text marginTop={1} fg={error === undefined ? theme.dim : theme.red}>
        {error ?? "An existing player's name moves him to the new position."}
      </text>
    </Overlay>
  )
}

// ---------------------------------------------------------------------------
// Command bar
// ---------------------------------------------------------------------------

const logColors = { input: theme.dim, output: theme.text, error: theme.red } as const

const CommandBar = (
  { state, game, text, setText, mode, onSubmit, focused }: {
    readonly state: ScorerState
    readonly game: GameState | undefined
    readonly text: string
    readonly setText: (s: string) => void
    readonly mode: Mode
    readonly onSubmit: (s: string) => void
    readonly focused: boolean
  }
) => {
  const issues = game === undefined ? [] : defenseIssues(game)
  const preview = text.trim() === "" && issues.length > 0 ? { text: `⚠ ${issues[0]}`, error: true } : previewLine(text, game)
  const recent = state.log
    .flatMap((l) => l.text.split("\n").map((t) => ({ kind: l.kind, text: l.kind === "input" ? `› ${t}` : t })))
    .slice(-3)
  const count = countAfter(state.pitches)
  const pitchMode = mode === "pitch"
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={theme.bg}>
      <box
        border
        borderStyle="rounded"
        borderColor={pitchMode ? theme.green : theme.borderFocus}
        title={pitchMode ? " Pitch pad — B C S F X … · Enter/Esc: type event " : " Event — Retrosheet notation · Esc: pitch pad "}
        titleColor={pitchMode ? theme.green : theme.accent}
        height={4}
        flexDirection="column"
        backgroundColor={theme.panel}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" height={1}>
          <text fg={theme.dim} width={9}>Pitches</text>
          <text fg={pitchMode ? theme.green : theme.text} width={Math.max(4, state.pitches.length + 1)}>
            {state.pitches === "" ? "—" : state.pitches}
          </text>
          <text fg={theme.yellow} width={7}>{`(${count.balls}-${count.strikes})`}</text>
          <text fg={theme.accent} width={2}>›</text>
          <input
            flexGrow={1}
            value={text}
            placeholder={pitchMode ? "" : "S8/G.1-2  ·  K  ·  64(1)3/GDP  ·  SB2  ·  ph Name  ·  help"}
            focused={focused && !pitchMode}
            onInput={setText}
            onSubmit={(v: string | SubmitEvent) => onSubmit(typeof v === "string" ? v : text)}
            backgroundColor={theme.panel}
            focusedBackgroundColor={theme.inputFocusBg}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.faint}
          />
        </box>
        <text fg={preview.error ? theme.red : theme.dim} height={1}>{preview.text === "" ? " " : preview.text}</text>
      </box>
      <box flexDirection="column" height={3} paddingLeft={1}>
        {recent.map((l, i) => <text key={i} fg={logColors[l.kind]} height={1}>{l.text}</text>)}
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export const ScoringScreen = ({ store, state }: { readonly store: ScorerStore; readonly state: ScorerState }) => {
  const dims = useTerminalDimensions()
  const game = currentGame(state)
  const [view, setView] = useState<View>("game")
  const [bookSide, setBookSide] = useState<BookSide>("auto")
  const [mode, setMode] = useState<Mode>("event")
  const [text, setText] = useState("")
  const [modal, setModal] = useState<Modal | undefined>(undefined)
  const [subForm, setSubForm] = useState<SubForm>({ side: 0, slot: "1", position: "PH", name: "" })
  const [subField, setSubField] = useState(3)
  const [subError, setSubError] = useState<string | undefined>(undefined)
  const bookScroll = useRef<ScrollBoxRenderable | null>(null)

  const submit = (line: string) => {
    if (line.trim() === "") return
    void store.run(Scorer.use((s) => s.submit(line))).then((outcome) => {
      if (!outcome.ok) return
      setText("")
      const lines = outcome.output.split("\n")
      const input = classifyLine(line)
      if (input._tag === "Command" && lines.length > 3) {
        setModal({ _tag: "Output", title: line.trim(), text: outcome.output })
      }
    })
  }

  const openSub = () => {
    if (game === undefined) return
    const side = game.battingSide
    setSubForm({ side, slot: String(game.teams[side].nextSlot), position: "PH", name: "" })
    setSubField(3)
    setSubError(undefined)
    setModal({ _tag: "Sub" })
  }

  const submitSub = () => {
    const slot = Number(subForm.slot)
    const position = subPosition(subForm.position)
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return setSubError("Slot must be 0-9")
    if (position === undefined) return setSubError("Unknown position")
    if (subForm.name.trim() === "") return setSubError("Enter the player's name")
    void store.run(Scorer.use((s) => s.substitute({ side: subForm.side, slot, position, name: subForm.name }))).then((outcome) => {
      if (outcome.ok) setModal(undefined)
      else setSubError(outcome.output.replace(/^✗ /, ""))
    })
  }

  const handlePitch = (key: KeyEvent) => {
    const ch = key.sequence.length === 1 ? key.sequence : ""
    if (key.name === "backspace") {
      void store.run(Scorer.use((s) => s.removePitch))
      return
    }
    if (key.name === "return" || key.name === "space") {
      setMode("event")
      return
    }
    if (ch !== "" && isPitchCode(ch) && ch !== ".") {
      void store.run(Scorer.use((s) => s.addPitch(ch))).then((next) => {
        const implied = impliedEvent(next)
        if (implied !== undefined) {
          setText(implied)
          setMode("event")
        } else if (inPlay(next)) {
          setText("")
          setMode("event")
        }
      })
    }
  }

  useKeyboard((key) => {
    if (modal?._tag === "Sub") {
      if (key.name === "escape") setModal(undefined)
      else if (key.name === "tab") {
        key.preventDefault()
        setSubField((f) => (f + (key.shift ? 3 : 1)) % 4)
      } else if (key.name === "return") {
        key.preventDefault()
        submitSub()
      } else if (subField === 0 && (key.name === "left" || key.name === "right" || key.name === "space")) {
        const side = otherSide(subForm.side)
        setSubForm({ ...subForm, side, slot: game === undefined ? subForm.slot : String(game.teams[side].nextSlot) })
      }
      return
    }
    if (modal !== undefined) {
      if (key.name === "escape" || key.name === "return" || key.name === "q") setModal(undefined)
      return
    }
    if (key.name === "tab") {
      key.preventDefault()
      setView((v) => (v === "game" ? "scorebook" : "game"))
    } else if (key.ctrl && key.name === "t") {
      key.preventDefault()
      setBookSide((s) => (s === "auto" ? 0 : s === 0 ? 1 : "auto"))
      setView("scorebook")
    } else if (key.name === "escape") {
      key.preventDefault()
      setMode((m) => (m === "event" ? "pitch" : "event"))
    } else if (key.ctrl && key.name === "n") {
      key.preventDefault()
      openSub()
    } else if (key.ctrl && key.name === "z") {
      key.preventDefault()
      void store.run(Scorer.use((s) => s.undo))
    } else if (key.ctrl && key.name === "l") {
      key.preventDefault()
      setModal({
        _tag: "Output",
        title: "Log",
        text: state.log.map((l) => (l.kind === "input" ? `› ${l.text}` : l.text)).join("\n") || "(empty)"
      })
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault()
      bookScroll.current?.scrollBy(key.name === "pageup" ? -10 : 10)
    } else if (key.name === "f1" || (mode === "pitch" && key.sequence === "?")) {
      key.preventDefault()
      setModal({ _tag: "Help" })
    } else if (mode === "pitch") {
      key.preventDefault()
      handlePitch(key)
    }
  })

  const side: Side = bookSide === "auto" ? (game?.battingSide ?? 0) : bookSide
  const bodyHeight = dims.height - 5 - 7 - 1
  const footer = useMemo(
    () => `Tab ${view === "game" ? "scorebook" : "game view"} · Esc ${mode === "event" ? "pitch pad" : "type event"} · ^N sub · ^Z undo · ^T team · F1 help · ^C quit`,
    [view, mode]
  )

  if (game === undefined) return <text>No game.</text>
  return (
    <box flexDirection="column" width={dims.width} height={dims.height} backgroundColor={theme.bg}>
      <Scoreboard game={game} pitches={state.pitches} width={dims.width} />
      {view === "game"
        ? <GameView game={game} pitches={state.pitches} width={dims.width} height={bodyHeight} />
        : <ScorebookView game={game} side={side} pitches={state.pitches} width={dims.width} scrollRef={bookScroll} />}
      <CommandBar
        state={state}
        game={game}
        text={text}
        setText={setText}
        mode={mode}
        onSubmit={submit}
        focused={modal === undefined}
      />
      <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={theme.panel}>
        <text fg={theme.dim} flexGrow={1}>{footer}</text>
        <text fg={theme.faint}>{state.savePath === undefined ? "not saving " : `${state.savePath} `}</text>
      </box>
      {modal?._tag === "Help" && <TextOverlay title="Help" text={helpText()} />}
      {modal?._tag === "Output" && <TextOverlay title={modal.title} text={modal.text} />}
      {modal?._tag === "Sub" && (
        <SubDialog game={game} roster={state.rosters[subForm.side]} form={subForm} field={subField} onChange={setSubForm} error={subError} />
      )}
    </box>
  )
}
