/**
 * The traditional scorebook page: batting order down the side, innings
 * across, and in each box the play plus a small diamond tracing the batter's
 * trip around the bases.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import type { RefObject } from "react"
import { type GameState, otherSide, playerName, teamCode } from "../../retrosheet/Game.ts"
import type { Side } from "../../retrosheet/Record.ts"
import { buildScorebook, cellKey, type Scorebook, type ScorebookCell } from "../Scorebook.ts"
import { inningsPitched, pitchCount } from "../Stats.ts"
import { Canvas, CanvasView, type CellStyle } from "./Canvas.tsx"
import { theme } from "./theme.ts"

const CELL = 9 // inner width of a box
const NAME = 22
const TOTALS = 16
const ROW = 3

const circled = ["", "①", "②", "③"]

const truncate = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, Math.max(0, n - 1)).join("") + "…" : s)

const drawCell = (canvas: Canvas, x: number, y: number, cell: ScorebookCell, bg: string) => {
  const reached = cell.reached
  const on = (b: number): CellStyle =>
    reached === 4 ? { fg: theme.red, bold: true } : reached >= b ? { fg: theme.green, bold: true } : { fg: theme.faint }
  const hit = /^(1B|2B|3B|HR|GRD)/.test(cell.notation)
  const outColor = cell.out !== undefined && reached === 0
  canvas.put(x, y, truncate(cell.notation, 6).padEnd(6), {
    fg: hit ? theme.yellow : outColor ? theme.text : theme.accent,
    bold: hit,
    bg
  })
  // The diamond: 2nd on top, 3rd left, 1st right, home at the bottom.
  canvas.put(x + 7, y, reached >= 2 ? "◆" : "◇", on(2))
  canvas.put(x + 6, y + 1, reached >= 3 ? "◆" : "◇", on(3))
  canvas.put(x + 8, y + 1, reached >= 1 ? "◆" : "◇", on(1))
  canvas.put(x + 7, y + 2, reached === 4 ? "●" : "·", reached === 4 ? { fg: theme.red, bold: true } : { fg: theme.faint })

  const second: Array<{ text: string; style: CellStyle }> = []
  if (cell.out !== undefined) second.push({ text: circled[cell.out] ?? "", style: { fg: theme.red, bold: true } })
  for (const t of cell.tags) second.push({ text: t, style: { fg: theme.orange } })
  if (cell.rbi > 0) second.push({ text: cell.rbi > 1 ? `${cell.rbi}RBI` : "RBI", style: { fg: theme.purple } })
  let cx = x
  for (const part of second) {
    if (cx - x + [...part.text].length > 6) break
    canvas.put(cx, y + 1, part.text, part.style)
    cx += [...part.text].length + 1
  }
  const third = cell.leftOnBase ? "LOB" : cell.advances.join(" ")
  canvas.put(x, y + 2, truncate(third, 6), { fg: cell.leftOnBase ? theme.dim : theme.green })
}

/** Which columns fit, keeping the current one in view. */
const visibleColumns = (book: Scorebook, width: number) => {
  const fit = Math.max(1, Math.floor((width - NAME - TOTALS) / (CELL + 1)))
  const total = book.columns.length
  if (total <= fit) return { start: 0, count: total }
  const focus = book.current?.column ?? total - 1
  const start = Math.min(Math.max(0, focus - fit + 2), total - fit)
  return { start, count: fit }
}

export const drawScorebook = (game: GameState, side: Side, width: number): Canvas => {
  const book = buildScorebook(game, side)
  const { start, count } = visibleColumns(book, width)
  const columns = book.columns.slice(start, start + count)
  const gridWidth = NAME + columns.length * (CELL + 1) + 1
  const totalsX = gridWidth + 1
  const height = 2 + book.rows.length * ROW + 4
  const canvas = new Canvas(Math.max(width, totalsX + TOTALS), height, { bg: theme.bg, fg: theme.text })

  // Header.
  canvas.put(1, 0, truncate(`${teamCode(game, side)} batting`, NAME - 2), { fg: theme.yellow, bold: true })
  columns.forEach((col, i) => {
    const x = NAME + i * (CELL + 1)
    const label = col.pass === 0 ? String(col.inning) : `${col.inning}${"'".repeat(col.pass)}`
    const current = game.phase === "in-progress" && game.inning === col.inning && game.battingSide === side
    canvas.put(x, 0, "│", { fg: theme.border })
    canvas.center(x + 1 + Math.floor(CELL / 2), 0, label, { fg: current ? theme.yellow : theme.dim, bold: current })
  })
  canvas.put(gridWidth - 1, 0, "│", { fg: theme.border })
  canvas.put(totalsX, 0, "AB  R  H RBI", { fg: theme.dim })
  canvas.put(0, 1, "─".repeat(canvas.width), { fg: theme.border })
  columns.forEach((_, i) => canvas.put(NAME + i * (CELL + 1), 1, "┼", { fg: theme.border }))
  canvas.put(gridWidth - 1, 1, "┼", { fg: theme.border })

  // Rows.
  book.rows.forEach((row, r) => {
    const y = 2 + r * ROW
    const bg = r % 2 === 0 ? theme.bg : theme.panel
    canvas.fill(0, y, canvas.width, ROW, { bg })
    canvas.put(1, y, String(row.slot), { fg: theme.dim })
    const shown = row.players.slice(-ROW)
    shown.forEach((p, k) => {
      const active = !p.removed
      canvas.put(3, y + k, truncate(p.name, NAME - 8), { fg: active ? theme.text : theme.dim })
      canvas.put(NAME - 4, y + k, p.position.padStart(3), { fg: active ? theme.accent : theme.faint })
    })
    columns.forEach((_, i) => {
      const x = NAME + i * (CELL + 1)
      for (let k = 0; k < ROW; k++) canvas.put(x, y + k, "│", { fg: theme.border })
      const column = start + i
      const cell = book.cells.get(cellKey(row.slot, column))
      const isCurrent = book.current?.slot === row.slot && book.current.column === column
      if (isCurrent) {
        canvas.fill(x + 1, y, CELL, ROW, { bg: theme.selection })
        canvas.put(x + 1, y + 1, "▶ at bat", { fg: theme.green, bold: true })
      }
      if (cell !== undefined) drawCell(canvas, x + 1, y, cell, isCurrent ? theme.selection : bg)
    })
    for (let k = 0; k < ROW; k++) canvas.put(gridWidth - 1, y + k, "│", { fg: theme.border })
    // Batting totals for everyone who has batted in this slot.
    const totals = row.players.reduce(
      (acc, p) => {
        const l = game.batting[p.id]
        return l === undefined ? acc : { ab: acc.ab + l.ab, r: acc.r + l.r, h: acc.h + l.h, rbi: acc.rbi + l.rbi }
      },
      { ab: 0, r: 0, h: 0, rbi: 0 }
    )
    canvas.put(totalsX, y + 1, `${String(totals.ab).padStart(2)} ${String(totals.r).padStart(2)} ${String(totals.h).padStart(2)} ${
      String(totals.rbi).padStart(3)
    }`, { fg: theme.text })
  })

  // Inning totals.
  const fy = 2 + book.rows.length * ROW
  canvas.put(0, fy, "─".repeat(canvas.width), { fg: theme.border })
  columns.forEach((_, i) => canvas.put(NAME + i * (CELL + 1), fy, "┴", { fg: theme.border }))
  canvas.put(gridWidth - 1, fy, "┴", { fg: theme.border })
  canvas.put(1, fy + 1, "R / H", { fg: theme.dim })
  canvas.put(1, fy + 2, "E / LOB", { fg: theme.dim })
  columns.forEach((col, i) => {
    if (col.pass !== 0) return
    const t = book.totals[col.inning - 1]
    const played = game.lineScore[side][col.inning - 1] !== undefined
    if (t === undefined || !played) return
    const x = NAME + i * (CELL + 1) + 1
    canvas.center(x + Math.floor(CELL / 2), fy + 1, `${t.runs} / ${t.hits}`, { fg: t.runs > 0 ? theme.yellow : theme.text })
    canvas.center(x + Math.floor(CELL / 2), fy + 2, `${t.errors} / ${t.leftOnBase}`, { fg: theme.dim })
  })
  const sum = (f: (t: Scorebook["totals"][number]) => number) => book.totals.reduce((a, t) => a + f(t), 0)
  canvas.put(totalsX, fy + 1, `R ${game.score[side]}  H ${game.hits[side]}`, { fg: theme.yellow, bold: true })
  canvas.put(totalsX, fy + 2, `E ${sum((t) => t.errors)}  LOB ${game.leftOnBase[side]}`, { fg: theme.dim })
  if (start > 0) canvas.put(NAME - 2, 0, "◀", { fg: theme.yellow })
  if (start + count < book.columns.length) canvas.put(gridWidth, 0, "▶", { fg: theme.yellow })
  return canvas
}

/** The opposing pitchers, as listed at the foot of a scorebook page. */
const PitchersLine = ({ game, side, pitches }: { readonly game: GameState; readonly side: Side; readonly pitches: string }) => {
  const team = game.teams[otherSide(side)]
  const fielding = game.phase === "in-progress" && game.battingSide === side
  return (
    <box flexDirection="column" paddingLeft={1} flexShrink={0}>
      <text fg={theme.dim}>{`${teamCode(game, otherSide(side))} pitching        IP   H   R  BB   K    P`}</text>
      {team.pitchers.map((id) => {
        const l = game.pitching[id]
        if (l === undefined) return null
        const current = team.fielders[1] === id
        const n = pitchCount(game, id, current && fielding ? pitches : "")
        const cols = [inningsPitched(l.outs), l.h, l.r, l.bb, l.so, n].map((v, i) => String(v).padStart(i === 0 ? 5 : 4)).join("")
        return (
          <text key={id} fg={current ? theme.accent : theme.text}>
            {`${truncate(playerName(game, id), 20).padEnd(20)}${cols}`}
          </text>
        )
      })}
    </box>
  )
}

export const ScorebookView = (
  { game, side, pitches, width, scrollRef }: {
    readonly game: GameState
    readonly side: Side
    readonly pitches: string
    readonly width: number
    readonly scrollRef: RefObject<ScrollBoxRenderable | null>
  }
) => (
  <scrollbox ref={scrollRef} flexGrow={1} backgroundColor={theme.bg} scrollY>
    <CanvasView canvas={drawScorebook(game, side, width)} />
    <PitchersLine game={game} side={side} pitches={pitches} />
  </scrollbox>
)
