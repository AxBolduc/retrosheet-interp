/**
 * The line score across the top of the scoring screen, with the inning,
 * count and outs at the right.
 */
import type { GameState } from "../../retrosheet/Game.ts"
import { ordinal, teamCode } from "../../retrosheet/Game.ts"
import { countAfter } from "../Pitches.ts"
import { Canvas, CanvasView } from "./Canvas.tsx"
import { theme } from "./theme.ts"

const dots = (canvas: Canvas, x: number, y: number, n: number, max: number, color: string) => {
  for (let i = 0; i < max; i++) canvas.put(x + i * 2, y, i < n ? "●" : "○", { fg: i < n ? color : theme.faint })
}

export const Scoreboard = (
  { game, pitches, width }: { readonly game: GameState; readonly pitches: string; readonly width: number }
) => {
  const played = Math.max(game.lineScore[0].length, game.lineScore[1].length)
  const innings = Math.max(game.scheduledInnings, played)
  const statusWidth = 30
  const cell = 3
  const nameW = 6
  const fit = Math.max(1, Math.floor((width - nameW - 12 - statusWidth - 4) / cell))
  const first = Math.max(1, innings - fit + 1)
  const canvas = new Canvas(Math.max(20, width - 2), 3, { bg: theme.panel, fg: theme.text })
  let x = nameW + 1
  for (let i = first; i <= innings; i++, x += cell) {
    const current = game.phase === "in-progress" && i === game.inning
    canvas.put(x, 0, String(i).padStart(2), { fg: current ? theme.yellow : theme.dim, bold: current })
  }
  const totalsX = x + 1
  canvas.put(totalsX, 0, " R  H  E", { fg: theme.dim })
  for (const side of [0, 1] as const) {
    const y = side + 1
    const batting = game.phase === "in-progress" && game.battingSide === side
    canvas.put(1, y, `${batting ? "▸" : " "}${teamCode(game, side).slice(0, 4)}`, {
      fg: batting ? theme.yellow : theme.text,
      bold: true
    })
    let cx = nameW + 1
    for (let i = first; i <= innings; i++, cx += cell) {
      const runs = game.lineScore[side][i - 1]
      const homeSkipped = side === 1 && game.phase === "final" && runs === undefined && i <= game.lineScore[0].length
      const text = runs === undefined ? (homeSkipped ? "X" : "") : String(runs)
      canvas.put(cx, y, text.padStart(2), { fg: runs !== undefined && runs > 0 ? theme.text : theme.dim })
    }
    canvas.put(totalsX, y, String(game.score[side]).padStart(2), { fg: theme.yellow, bold: true })
    canvas.put(totalsX + 3, y, String(game.hits[side]).padStart(2), { fg: theme.text })
    canvas.put(totalsX + 6, y, String(game.errors[side]).padStart(2), { fg: theme.text })
  }

  const sx = canvas.width - statusWidth
  if (game.phase === "final") {
    canvas.put(sx, 1, "FINAL", { fg: theme.yellow, bold: true })
  } else if (game.phase === "pregame") {
    canvas.put(sx, 1, "Pregame — first pitch!", { fg: theme.dim })
  } else {
    const count = countAfter(pitches)
    canvas.put(sx, 0, `${game.battingSide === 0 ? "▲ Top" : "▼ Bot"} ${ordinal(game.inning)}`, { fg: theme.yellow, bold: true })
    canvas.put(sx, 1, "B", { fg: theme.dim })
    dots(canvas, sx + 2, 1, count.balls, 3, theme.green)
    canvas.put(sx + 9, 1, "S", { fg: theme.dim })
    dots(canvas, sx + 11, 1, count.strikes, 2, theme.red)
    canvas.put(sx + 16, 1, "O", { fg: theme.dim })
    dots(canvas, sx + 18, 1, game.outs, 2, theme.orange)
    canvas.put(sx, 2, `${count.balls}-${count.strikes}, ${game.outs} out`, { fg: theme.dim })
  }
  return (
    <box border borderColor={theme.border} backgroundColor={theme.panel} height={5} flexShrink={0} paddingLeft={0}>
      <CanvasView canvas={canvas} />
    </box>
  )
}
