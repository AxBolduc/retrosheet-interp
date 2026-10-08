/**
 * The pre-game screen: game details and both lineups, then "play ball".
 */
import type { KeyEvent, SubmitEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { Effect } from "effect"
import { useMemo, useState } from "react"
import { positionAbbrev } from "../../retrosheet/Game.ts"
import type { Side } from "../../retrosheet/Record.ts"
import { Scorer } from "../Scorer.ts"
import {
  emptySetup,
  exampleSetup,
  type GameSetup,
  type LineupEntry,
  parsePosition,
  type SetupField,
  type SetupIssue,
  validateSetup
} from "../Setup.ts"
import type { ScorerStore } from "./store.ts"
import { theme } from "./theme.ts"

/** The form: like a GameSetup, but numbers are kept as typed. */
interface Form {
  readonly date: string
  readonly gameNumber: string
  readonly innings: string
  readonly useDH: boolean
  readonly site: string
  readonly teams: readonly [TeamForm, TeamForm]
}

interface TeamForm {
  readonly code: string
  readonly lineup: ReadonlyArray<LineupEntry>
  readonly pitcher: string
}

type FieldId =
  | { readonly _tag: "date" }
  | { readonly _tag: "number" }
  | { readonly _tag: "innings" }
  | { readonly _tag: "dh" }
  | { readonly _tag: "site" }
  | { readonly _tag: "code"; readonly side: Side }
  | { readonly _tag: "name"; readonly side: Side; readonly slot: number }
  | { readonly _tag: "pos"; readonly side: Side; readonly slot: number }
  | { readonly _tag: "pitcher"; readonly side: Side }

const toForm = (s: GameSetup): Form => ({
  date: s.date,
  gameNumber: String(s.gameNumber),
  innings: String(s.innings),
  useDH: s.useDH,
  site: s.site,
  teams: s.teams
})

const toSetup = (f: Form): GameSetup => ({
  date: f.date.trim(),
  gameNumber: Number(f.gameNumber) || 0,
  innings: Number(f.innings),
  useDH: f.useDH,
  site: f.site,
  teams: f.teams
})

/** All fields in Tab order, with grid coordinates for arrow-key movement. */
const fieldsFor = (form: Form): ReadonlyArray<{ readonly id: FieldId; readonly row: number; readonly col: number }> => {
  const out: Array<{ id: FieldId; row: number; col: number }> = [
    { id: { _tag: "date" }, row: 0, col: 0 },
    { id: { _tag: "number" }, row: 0, col: 1 },
    { id: { _tag: "innings" }, row: 0, col: 1.5 },
    { id: { _tag: "dh" }, row: 0, col: 2 },
    { id: { _tag: "site" }, row: 0, col: 3 }
  ]
  for (const side of [0, 1] as const) {
    const c = side * 2
    out.push({ id: { _tag: "code", side }, row: 1, col: c })
    for (let slot = 1; slot <= 9; slot++) {
      out.push({ id: { _tag: "name", side, slot }, row: 1 + slot, col: c })
      out.push({ id: { _tag: "pos", side, slot }, row: 1 + slot, col: c + 1 })
    }
    if (form.useDH) out.push({ id: { _tag: "pitcher", side }, row: 11, col: c })
  }
  return out
}

const sameField = (a: FieldId, b: FieldId) => JSON.stringify(a) === JSON.stringify(b)

const fieldOfIssue = (f: SetupField): FieldId => {
  switch (f._tag) {
    case "Game":
      return { _tag: f.key }
    case "Code":
      return { _tag: "code", side: f.side }
    case "Name":
      return { _tag: "name", side: f.side, slot: f.slot }
    case "Position":
      return { _tag: "pos", side: f.side, slot: f.slot }
    case "Pitcher":
      return { _tag: "pitcher", side: f.side }
  }
}

const getValue = (form: Form, id: FieldId): string => {
  switch (id._tag) {
    case "date":
      return form.date
    case "number":
      return form.gameNumber
    case "innings":
      return form.innings
    case "dh":
      return form.useDH ? "Yes" : "No"
    case "site":
      return form.site
    case "code":
      return form.teams[id.side].code
    case "name":
      return form.teams[id.side].lineup[id.slot - 1]?.name ?? ""
    case "pos":
      return form.teams[id.side].lineup[id.slot - 1]?.position ?? ""
    case "pitcher":
      return form.teams[id.side].pitcher
  }
}

const setTeam = (form: Form, side: Side, f: (t: TeamForm) => TeamForm): Form => ({
  ...form,
  teams: side === 0 ? [f(form.teams[0]), form.teams[1]] : [form.teams[0], f(form.teams[1])]
})

const setLineup = (form: Form, side: Side, slot: number, f: (e: LineupEntry) => LineupEntry): Form =>
  setTeam(form, side, (t) => ({ ...t, lineup: t.lineup.map((e, i) => (i === slot - 1 ? f(e) : e)) }))

const setValue = (form: Form, id: FieldId, value: string): Form => {
  switch (id._tag) {
    case "date":
      return { ...form, date: value }
    case "number":
      return { ...form, gameNumber: value }
    case "innings":
      return { ...form, innings: value }
    case "dh":
      return form
    case "site":
      return { ...form, site: value }
    case "code":
      return setTeam(form, id.side, (t) => ({ ...t, code: value.toUpperCase() }))
    case "name":
      return setLineup(form, id.side, id.slot, (e) => ({ ...e, name: value }))
    case "pos":
      return setLineup(form, id.side, id.slot, (e) => ({ ...e, position: value }))
    case "pitcher":
      return setTeam(form, id.side, (t) => ({ ...t, pitcher: value }))
  }
}

const Field = (
  { id, form, focus, width, onChange, onSubmit, placeholder, invalid }: {
    readonly id: FieldId
    readonly form: Form
    readonly focus: FieldId | undefined
    readonly width: number
    readonly onChange: (f: (form: Form) => Form) => void
    readonly onSubmit: () => void
    readonly placeholder?: string
    readonly invalid?: boolean
  }
) => {
  const focused = focus !== undefined && sameField(focus, id)
  return (
    <input
      width={width}
      flexShrink={0}
      value={getValue(form, id)}
      focused={focused}
      onInput={(v) => onChange((prev) => (getValue(prev, id) === v ? prev : setValue(prev, id, v)))}
      onSubmit={(_: string | SubmitEvent) => onSubmit()}
      placeholder={placeholder ?? ""}
      backgroundColor={invalid ? "#3a1f24" : theme.inputBg}
      focusedBackgroundColor={theme.inputFocusBg}
      textColor={theme.text}
      focusedTextColor={theme.text}
      placeholderColor={theme.faint}
    />
  )
}

const TeamColumn = (
  { side, form, focus, setForm, next, issues, width }: {
    readonly side: Side
    readonly form: Form
    readonly focus: FieldId | undefined
    readonly setForm: (f: (form: Form) => Form) => void
    readonly next: () => void
    readonly issues: ReadonlyArray<SetupIssue>
    readonly width: number
  }
) => {
  const team = form.teams[side]
  const nameWidth = Math.max(14, width - 16)
  const invalid = (id: FieldId) => issues.some((i) => sameField(fieldOfIssue(i.field), id))
  const props = { form, focus, onChange: setForm, onSubmit: next }
  const active = focus !== undefined && "side" in focus && focus.side === side
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={active ? theme.borderFocus : theme.border}
      title={side === 0 ? " Away (bats first) " : " Home "}
      titleColor={active ? theme.accent : theme.text}
      flexDirection="column"
      width={width}
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" height={1}>
        <text width={11} fg={theme.dim}>Team code</text>
        <Field id={{ _tag: "code", side }} width={6} placeholder={side === 0 ? "BOS" : "NYA"} invalid={invalid({ _tag: "code", side })} {...props} />
        <text fg={theme.faint}>{"  Retrosheet code, e.g. NYA, BOS, SFN"}</text>
      </box>
      <box flexDirection="row" height={1} marginTop={1}>
        <text width={4} fg={theme.dim}>#</text>
        <text width={nameWidth + 1} fg={theme.dim}>Name</text>
        <text fg={theme.dim}>Pos</text>
      </box>
      {team.lineup.map((entry, i) => {
        const slot = i + 1
        const pos = parsePosition(entry.position)
        return (
          <box key={slot} flexDirection="row" height={1}>
            <text width={4} fg={theme.dim}>{String(slot)}</text>
            <Field id={{ _tag: "name", side, slot }} width={nameWidth} placeholder="Player name" invalid={invalid({ _tag: "name", side, slot })} {...props} />
            <text width={1}> </text>
            <Field id={{ _tag: "pos", side, slot }} width={4} invalid={invalid({ _tag: "pos", side, slot })} {...props} />
            <text width={4} fg={entry.position === "" ? theme.faint : pos === undefined ? theme.red : theme.accent}>
              {pos === undefined ? (entry.position === "" ? "" : " ?") : positionAbbrev(pos) === entry.position.trim().toUpperCase() ? "" : ` ${positionAbbrev(pos)}`}
            </text>
          </box>
        )
      })}
      <box flexDirection="row" height={1} marginTop={1}>
        {form.useDH
          ? (
            <>
              <text width={4} fg={theme.dim}>P</text>
              <Field id={{ _tag: "pitcher", side }} width={nameWidth} placeholder="Starting pitcher" invalid={invalid({ _tag: "pitcher", side })} {...props} />
            </>
          )
          : <text fg={theme.faint}>No DH: the pitcher bats (position P in the order)</text>}
      </box>
    </box>
  )
}

export const SetupScreen = (
  { store, onStarted, autosaveDir }: {
    readonly store: ScorerStore
    readonly onStarted: () => void
    readonly autosaveDir: string | undefined
  }
) => {
  const dims = useTerminalDimensions()
  const [form, setForm] = useState<Form>(() => toForm(emptySetup()))
  const [focus, setFocus] = useState<FieldId | undefined>({ _tag: "code", side: 0 })
  const [tried, setTried] = useState(false)
  const [opening, setOpening] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState<string | undefined>(undefined)

  const fields = fieldsFor(form)
  const index = focus === undefined ? -1 : fields.findIndex((f) => sameField(f.id, focus))
  const move = (delta: number) => {
    const i = (index + delta + fields.length) % fields.length
    setFocus(fields[i]!.id)
  }
  const moveVertical = (dir: 1 | -1) => {
    const here = fields[index]
    if (here === undefined) return
    const candidates = fields.filter((f) => (dir === 1 ? f.row > here.row : f.row < here.row))
    if (candidates.length === 0) return
    const row = dir === 1 ? Math.min(...candidates.map((f) => f.row)) : Math.max(...candidates.map((f) => f.row))
    const inRow = candidates.filter((f) => f.row === row)
    const best = inRow.reduce((a, b) => (Math.abs(b.col - here.col) < Math.abs(a.col - here.col) ? b : a))
    setFocus(best.id)
  }

  const update = (f: (form: Form) => Form) => setForm(f)
  const issues: ReadonlyArray<SetupIssue> = useMemo(() => (tried ? validateSetup(toSetup(form)) : []), [tried, form])

  const start = () => {
    const setup = toSetup(form)
    const found = validateSetup(setup)
    setTried(true)
    if (found.length > 0) {
      setFocus(fieldOfIssue(found[0]!.field))
      return
    }
    void store.run(
      Scorer.use((s) =>
        Effect.gen(function*() {
          yield* s.startGame(setup)
          if (autosaveDir !== undefined) yield* s.autosaveTo(autosaveDir)
        })
      )
    ).then(onStarted, (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
  }

  const openFile = (path: string) => {
    if (path.trim() === "") return
    void store.run(Scorer.use((s) => s.load(path.trim()))).then((outcome) => {
      if (outcome.ok) {
        setOpening(undefined)
        onStarted()
      } else setMessage(outcome.output)
    })
  }

  useKeyboard((key: KeyEvent) => {
    if (opening !== undefined) {
      if (key.name === "escape") {
        setOpening(undefined)
        setMessage(undefined)
      }
      return
    }
    const dhFocused = focus?._tag === "dh"
    if (key.name === "tab") {
      key.preventDefault()
      move(key.shift ? -1 : 1)
    } else if (key.name === "down") {
      key.preventDefault()
      moveVertical(1)
    } else if (key.name === "up") {
      key.preventDefault()
      moveVertical(-1)
    } else if ((key.ctrl && key.name === "g") || key.name === "f5") {
      key.preventDefault()
      start()
    } else if (key.ctrl && key.name === "e") {
      key.preventDefault()
      update(() => toForm(exampleSetup()))
    } else if (key.ctrl && key.name === "o") {
      key.preventDefault()
      setMessage(undefined)
      setOpening("")
    } else if (dhFocused && ["space", "left", "right", "y", "n", "return"].includes(key.name)) {
      key.preventDefault()
      if (key.name === "return") move(1)
      else update((f) => ({ ...f, useDH: key.name === "y" ? true : key.name === "n" ? false : !f.useDH }))
    }
  })

  const width = dims.width
  const colWidth = Math.max(40, Math.floor((width - 3) / 2))
  const props = { form, focus, onChange: update, onSubmit: () => move(1) }
  const invalid = (id: FieldId) => issues.some((i) => sameField(fieldOfIssue(i.field), id))
  const label = (text: string, w: number) => <text width={w} fg={theme.dim}>{text}</text>

  return (
    <box flexDirection="column" width={dims.width} height={dims.height} backgroundColor={theme.bg}>
      <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={theme.panel}>
        <text fg={theme.yellow}>⚾ </text>
        <text fg={theme.text}>New game</text>
        <text fg={theme.dim}>{"  — enter the lineups, then press Ctrl+G (or F5) to play ball"}</text>
      </box>
      <box
        border
        borderStyle="rounded"
        borderColor={focus !== undefined && fields[index]?.row === 0 ? theme.borderFocus : theme.border}
        title=" Game "
        flexDirection="row"
        height={3}
        backgroundColor={theme.panel}
        paddingLeft={1}
        gap={1}
      >
        {label("Date", 5)}
        <Field id={{ _tag: "date" }} width={14} invalid={invalid({ _tag: "date" })} {...props} />
        {label(" Game #", 8)}
        <Field id={{ _tag: "number" }} width={3} {...props} />
        {label(" Innings", 9)}
        <Field id={{ _tag: "innings" }} width={3} invalid={invalid({ _tag: "innings" })} {...props} />
        {label(" DH", 4)}
        <text
          width={7}
          fg={focus?._tag === "dh" ? theme.bg : theme.text}
          bg={focus?._tag === "dh" ? theme.accent : theme.inputBg}
        >
          {form.useDH ? " ● Yes " : " ○ No  "}
        </text>
        {label(" Site", 6)}
        <Field id={{ _tag: "site" }} width={10} placeholder="optional" {...props} />
      </box>
      <box flexDirection="row" gap={1}>
        {([0, 1] as const).map((side) => (
          <TeamColumn
            key={side}
            side={side}
            form={form}
            focus={opening === undefined ? focus : undefined}
            setForm={update}
            next={() => move(1)}
            issues={issues}
            width={colWidth}
          />
        ))}
      </box>
      <box flexDirection="column" paddingLeft={1} flexGrow={1}>
        {issues.slice(0, 4).map((issue, i) => <text key={i} fg={theme.red} height={1}>{`✗ ${issue.message}`}</text>)}
        {issues.length > 4 && <text fg={theme.red}>{`  …and ${issues.length - 4} more`}</text>}
        {message !== undefined && opening === undefined && <text fg={theme.red}>{message}</text>}
        {tried && issues.length === 0 && message === undefined && <text fg={theme.green}>Lineups look good.</text>}
      </box>
      {opening !== undefined && (
        <box
          border
          borderStyle="rounded"
          borderColor={theme.borderFocus}
          title=" Open a Retrosheet event file "
          flexDirection="column"
          height={message === undefined ? 3 : 5}
          backgroundColor={theme.panel}
          paddingLeft={1}
        >
          <input
            focused
            value={opening}
            onInput={setOpening}
            onSubmit={(v: string | SubmitEvent) => openFile(typeof v === "string" ? v : opening)}
            placeholder="path/to/game.EVN — Enter to open, Esc to cancel"
            backgroundColor={theme.inputBg}
            focusedBackgroundColor={theme.inputFocusBg}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.faint}
          />
          {message !== undefined && <text fg={theme.red}>{message}</text>}
        </box>
      )}
      <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={theme.panel}>
        <text fg={theme.dim}>
          Tab/Enter next · Shift+Tab back · ↑↓ rows · Ctrl+G start · Ctrl+E example lineups · Ctrl+O open file · Ctrl+C quit
        </text>
      </box>
    </box>
  )
}
