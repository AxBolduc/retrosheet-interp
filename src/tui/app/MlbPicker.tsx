/**
 * The MLB game picker on the setup screen: a day's games from mlb.com, one
 * per line, to fill in the form from.
 */
import { useTerminalDimensions } from "@opentui/react"
import type { ScheduledGame } from "../../mlb/MlbApi.ts"
import { theme } from "./theme.ts"

export type PickerGames =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Loaded"; readonly games: ReadonlyArray<ScheduledGame> }
  | { readonly _tag: "Failed"; readonly message: string }

export interface PickerState {
  /** YYYY-MM-DD. */
  readonly date: string
  readonly games: PickerGames
  readonly index: number
  /** Set while the chosen game's lineups are being fetched. */
  readonly opening: ScheduledGame | undefined
  readonly error: string | undefined
}

/** Move a YYYY-MM-DD date by some days. */
export const shiftDate = (date: string, days: number): string => {
  const d = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const startTime = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

const lastName = (name: string | undefined) => name?.trim().split(/\s+/).slice(1).join(" ") || name || "TBD"

const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))

export const gameLabel = (g: ScheduledGame) => `${g.teams[0].name} @ ${g.teams[1].name}`

const statusColor = (g: ScheduledGame) =>
  g.isFinal ? theme.dim : /progress|warmup|delay/i.test(g.status) ? theme.green : theme.text

export const MlbPicker = ({ state }: { readonly state: PickerState }) => {
  const dims = useTerminalDimensions()
  const width = Math.min(dims.width - 4, 110)
  const games = state.games._tag === "Loaded" ? state.games.games : []
  const height = Math.min(dims.height - 2, Math.max(games.length, 3) + 6)
  const rows = height - 6
  const first = Math.max(0, Math.min(state.index - Math.floor(rows / 2), games.length - rows))
  const inner = width - 4
  const matchupWidth = Math.max(20, Math.min(40, inner - 9 - 14 - 30))
  const pitchersWidth = Math.max(10, inner - 2 - 9 - matchupWidth - 14)
  const day = new Date(`${state.date}T12:00:00Z`)
  const dayName = Number.isNaN(day.getTime())
    ? state.date
    : day.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
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
      title=" MLB games "
      titleColor={theme.accent}
      bottomTitle=" ↑↓ choose · Enter fill in lineups · ←→ day · T today · Esc cancel "
      bottomTitleAlignment="right"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" height={1}>
        <text fg={theme.dim}>{"◂ "}</text>
        <text fg={theme.yellow}>{dayName}</text>
        <text fg={theme.dim}>{" ▸"}</text>
      </box>
      <box flexDirection="row" height={1} marginTop={1}>
        <text fg={theme.dim}>{`  ${fit("Time", 9)}${fit("Matchup", matchupWidth)}${fit("Status", 14)}Probable pitchers`}</text>
      </box>
      <box flexDirection="column" flexGrow={1}>
        {state.games._tag === "Loading" && <text fg={theme.dim}>  Loading the schedule from mlb.com…</text>}
        {state.games._tag === "Failed" && <text fg={theme.red}>{`  ${state.games.message}`}</text>}
        {state.games._tag === "Loaded" && games.length === 0 && <text fg={theme.dim}>  No MLB games on this day. ←→ to look at another.</text>}
        {games.slice(first, first + rows).map((g, i) => {
          const selected = first + i === state.index
          const started = g.isFinal || /progress|delay|suspend/i.test(g.status)
          const score = started && g.teams[0].score !== undefined && g.teams[1].score !== undefined
            ? ` ${g.teams[0].score}-${g.teams[1].score}`
            : ""
          const pitchers = `${lastName(g.teams[0].probablePitcher)} vs ${lastName(g.teams[1].probablePitcher)}`
          const dh = g.gameNumber > 0 ? ` (game ${g.gameNumber})` : ""
          return (
            <box key={g.gamePk} flexDirection="row" height={1} backgroundColor={selected ? theme.selection : theme.panel}>
              <text fg={selected ? theme.accent : theme.faint}>{selected ? "▸ " : "  "}</text>
              <text fg={theme.dim}>{fit(startTime(g.start), 9)}</text>
              <text fg={theme.text}>{fit(`${gameLabel(g)}${dh}`, matchupWidth)}</text>
              <text fg={statusColor(g)}>{fit(`${g.status}${score}`, 14)}</text>
              <text fg={theme.dim}>{fit(pitchers, pitchersWidth)}</text>
            </box>
          )
        })}
      </box>
      <text fg={state.error !== undefined ? theme.red : theme.dim} height={1}>
        {state.error ??
          (state.opening !== undefined
            ? `Getting lineups and rosters for ${gameLabel(state.opening)}…`
            : games[state.index]?.description ?? " ")}
      </text>
    </box>
  )
}
