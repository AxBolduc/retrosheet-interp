/**
 * The "broadcast" view: both lineups at the sides, and in the middle a field
 * with the fielders, the runners on base, the batter and the pitcher.
 */
import {
  currentBatterId,
  currentPitcherId,
  dueUp,
  type GameState,
  otherSide,
  playerName,
  positionAbbrev,
  teamCode
} from "../../retrosheet/Game.ts"
import type { Side } from "../../retrosheet/Record.ts"
import { countAfter, impliedEvent } from "../Pitches.ts"
import { battingSummary, inningsPitched, pitchCount } from "../Stats.ts"
import { Canvas, CanvasView } from "./Canvas.tsx"
import { theme } from "./theme.ts"

const lastName = (name: string) => {
  const parts = name.trim().split(/\s+/)
  const suffix = /^(jr\.?|sr\.?|ii|iii|iv)$/i
  const words = parts.filter((p, i) => i === 0 || !suffix.test(p))
  return words.length > 1 ? words.slice(1).join(" ") : words[0] ?? name
}

const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, Math.max(0, n - 1)).join("") + "…" : s)

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

export const fieldSize = (r: number) => ({ width: 4 * r + 1 + 30, height: 2 * r + 6 })

/** Draw the field with infield "radius" r (rows from home to the mound). */
export const drawField = (game: GameState, r: number): Canvas => {
  const { width, height } = fieldSize(r)
  const canvas = new Canvas(width, height, { bg: theme.bg, fg: theme.text })
  const cx = Math.floor(width / 2)
  const y2 = 3
  const yH = y2 + 2 * r
  const yM = y2 + r
  const fence = yH - 0.6

  // Fair territory: grass inside the foul lines and the fence, a warning track along it.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / 2
      const dy = yH - y
      const fair = dy >= 0 && Math.abs(dx) <= dy
      const d = Math.hypot(dx, dy)
      if (!fair || d > fence) continue
      const infield = Math.abs(dx) + Math.abs(dy - r) <= r
      const bg = d > fence - 1 ? theme.dirt : infield ? theme.grassLight : theme.grass
      canvas.fill(x, y, 1, 1, { bg })
    }
  }
  // Base paths.
  const line = { fg: "#c8a26b" }
  for (let k = 1; k < r; k++) {
    canvas.put(cx + 2 * k, yH - k, "╱", line)
    canvas.put(cx - 2 * k, yH - k, "╲", line)
    canvas.put(cx - 2 * r + 2 * k, yM - k, "╱", line)
    canvas.put(cx + 2 * r - 2 * k, yM - k, "╲", line)
  }
  // Foul lines beyond the bases.
  for (let k = r + 1; ; k++) {
    if (yH - k < 0 || cx + 2 * k >= width) break
    if (Math.hypot(k, k) > fence) break
    canvas.put(cx + 2 * k, yH - k, "╱", { fg: theme.faint })
    canvas.put(cx - 2 * k, yH - k, "╲", { fg: theme.faint })
  }

  const defense = game.teams[otherSide(game.battingSide)]
  const fielder = (pos: number) => {
    const id = defense.fielders[pos]
    return id === undefined ? "" : lastName(playerName(game, id))
  }
  const dim = { fg: "#9fb3a5" }
  const fielderAt = (pos: number, x: number, y: number) => {
    const name = fielder(pos)
    if (name !== "") canvas.center(x, y, truncate(name, 12), dim)
  }
  const midY = Math.max(1, y2 - 2)
  fielderAt(7, cx - 2 * r - 4, midY + 1)
  fielderAt(8, cx, midY - 1 < 0 ? 0 : midY - 1)
  fielderAt(9, cx + 2 * r + 4, midY + 1)
  fielderAt(6, cx - r - 2, y2 + Math.floor(r / 2))
  fielderAt(4, cx + r + 2, y2 + Math.floor(r / 2))
  fielderAt(5, cx - 2 * r - 1, yM - 2)
  fielderAt(3, cx + 2 * r + 1, yM - 2)

  // Bases and runners.
  const base = (i: 0 | 1 | 2, x: number, y: number) => {
    const runner = game.bases[i]
    canvas.put(x, y, runner ? "◆" : "◇", runner ? { fg: theme.yellow, bold: true } : { fg: theme.text })
    return runner === undefined ? undefined : lastName(playerName(game, runner.playerId))
  }
  const on1 = base(0, cx + 2 * r, yM)
  const on2 = base(1, cx, y2)
  const on3 = base(2, cx - 2 * r, yM)
  const runnerStyle = { fg: theme.yellow, bold: true }
  if (on1 !== undefined) canvas.put(cx + 2 * r + 2, yM, truncate(on1, 13), runnerStyle)
  if (on2 !== undefined) canvas.center(cx, y2 - 1, truncate(on2, 14), runnerStyle)
  if (on3 !== undefined) {
    const t = truncate(on3, 13)
    canvas.put(cx - 2 * r - 1 - [...t].length, yM, t, runnerStyle)
  }

  // Mound, pitcher, plate, batter, catcher.
  const pitcherId = currentPitcherId(game)
  canvas.put(cx, yM, "●", { fg: "#c8a26b" })
  if (pitcherId !== undefined) canvas.center(cx, yM + 1, truncate(lastName(playerName(game, pitcherId)), 14), { fg: theme.accent })
  canvas.put(cx, yH, "⌂", { fg: theme.text, bold: true })
  const batterId = currentBatterId(game)
  if (batterId !== undefined && game.phase !== "final") {
    const t = `${truncate(lastName(playerName(game, batterId)), 14)} ▶`
    canvas.put(cx - 2 - [...t].length + 1, yH, t, { fg: theme.green, bold: true })
  }
  const catcher = fielder(2)
  if (catcher !== "") canvas.center(cx, yH + 1, truncate(catcher, 14), dim)
  return canvas
}

// ---------------------------------------------------------------------------
// Lineups
// ---------------------------------------------------------------------------

const LineupPanel = (
  { game, side, width, pitches }: { readonly game: GameState; readonly side: Side; readonly width: number; readonly pitches: string }
) => {
  const team = game.teams[side]
  const batting = game.phase === "in-progress" && game.battingSide === side
  const deck = batting ? dueUp(game, side, 2)[1]?.slot : undefined
  const nameWidth = width - 16
  const pitcherId = team.fielders[1]
  const pitcherLine = pitcherId === undefined ? undefined : game.pitching[pitcherId]
  const fielding = game.phase === "in-progress" && !batting
  return (
    <box
      border
      borderColor={batting ? theme.yellow : theme.border}
      title={` ${teamCode(game, side)} · ${side === 0 ? "Away" : "Home"} `}
      titleColor={batting ? theme.yellow : theme.text}
      width={width}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={theme.panel}
      paddingLeft={1}
      paddingRight={1}
    >
      {Array.from({ length: 9 }, (_, i) => {
        const slot = i + 1
        const id = team.lineup[slot]
        const up = batting && team.nextSlot === slot
        const onDeck = deck === slot
        const name = id === undefined ? "—" : playerName(game, id)
        const pos = positionAbbrev(id === undefined ? undefined : team.positions[id])
        const line = id === undefined ? "" : battingSummary(game, id).split(",")[0] ?? ""
        return (
          <box key={slot} flexDirection="row" height={1} backgroundColor={up ? theme.selection : theme.panel}>
            <text width={3} fg={up ? theme.green : onDeck ? theme.dim : theme.faint}>{up ? "▶" : onDeck ? "·" : " "}</text>
            <text width={2} fg={theme.dim}>{slot}</text>
            <text width={nameWidth} fg={up ? theme.green : theme.text}>{truncate(name, nameWidth - 1)}</text>
            <text width={3} fg={theme.accent}>{pos}</text>
            <text width={4} fg={theme.dim}>{line}</text>
          </box>
        )
      })}
      {team.lineup[0] !== undefined && (
        <box flexDirection="row" height={1}>
          <text width={5} fg={theme.dim}>{"   P"}</text>
          <text width={nameWidth + 7} fg={theme.text}>{truncate(playerName(game, team.lineup[0]), nameWidth + 6)}</text>
        </box>
      )}
      <text height={1} fg={theme.faint}>{"─".repeat(Math.max(0, width - 4))}</text>
      <text height={1} fg={fielding ? theme.accent : theme.dim}>
        {pitcherId === undefined ? "No pitcher" : truncate(`P ${playerName(game, pitcherId)}`, width - 4)}
      </text>
      {pitcherLine && pitcherId !== undefined && (
        <text height={1} fg={theme.dim}>
          {truncate(
            `${inningsPitched(pitcherLine.outs)} IP  ${pitcherLine.h}H ${pitcherLine.r}R ${pitcherLine.bb}BB ${pitcherLine.so}K  ${
              pitchCount(game, pitcherId, fielding ? pitches : "")
            }P`,
            width - 4
          )}
        </text>
      )}
    </box>
  )
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const Situation = ({ game, pitches, width }: { readonly game: GameState; readonly pitches: string; readonly width: number }) => {
  const batterId = currentBatterId(game)
  const pitcherId = currentPitcherId(game)
  const count = countAfter(pitches)
  const implied = impliedEvent(pitches)
  const last = game.plays[game.plays.length - 1]
  const summary = batterId === undefined ? "" : battingSummary(game, batterId)
  return (
    <box flexDirection="column" width={width} alignItems="center" flexShrink={0}>
      {game.phase === "final"
        ? <text fg={theme.yellow}>Final: {teamCode(game, 0)} {game.score[0]}, {teamCode(game, 1)} {game.score[1]}</text>
        : (
          <text>
            <span fg={theme.dim}>At bat </span>
            <span fg={theme.green}>{playerName(game, batterId)}</span>
            <span fg={theme.dim}>{summary === "" ? "" : ` (${summary})`}</span>
            <span fg={theme.dim}>{"  vs  "}</span>
            <span fg={theme.accent}>{playerName(game, pitcherId)}</span>
          </text>
        )}
      {game.phase !== "final" && (
        <text>
          <span fg={theme.dim}>Count </span>
          <span fg={theme.text}>{count.balls}-{count.strikes}</span>
          <span fg={theme.dim}>{pitches === "" ? "" : `  pitches ${pitches}`}</span>
          <span fg={theme.yellow}>{implied === undefined ? "" : `  → ${implied}`}</span>
        </text>
      )}
      {last && (
        <text fg={theme.dim} width={width} height={2} wrapMode="word">
          {truncate(`Last: ${playerName(game, last.batterId)} — ${last.description}`, width * 2 - 2)}
        </text>
      )}
    </box>
  )
}

export const GameView = (
  { game, pitches, width, height }: {
    readonly game: GameState
    readonly pitches: string
    readonly width: number
    readonly height: number
  }
) => {
  const side = Math.min(34, Math.max(26, Math.floor(width * 0.22)))
  const middle = Math.max(20, width - 2 * side - 2)
  // Pick the biggest field that fits.
  let r = 7
  while (r > 3 && (fieldSize(r).width > middle || fieldSize(r).height + 4 > height)) r--
  const field = drawField(game, r)
  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.bg}>
      <LineupPanel game={game} side={0} width={side} pitches={pitches} />
      <box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" backgroundColor={theme.bg}>
        <CanvasView canvas={field} />
        <Situation game={game} pitches={pitches} width={middle - 2} />
      </box>
      <LineupPanel game={game} side={1} width={side} pitches={pitches} />
    </box>
  )
}
