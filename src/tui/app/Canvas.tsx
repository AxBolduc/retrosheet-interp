/**
 * A grid of styled characters, for drawings (the diamond, the scorebook)
 * where exact placement matters more than layout.
 */
import { TextAttributes } from "@opentui/core"

export interface CellStyle {
  readonly fg?: string
  readonly bg?: string
  readonly bold?: boolean
}

interface Cell {
  ch: string
  style: CellStyle
}

export class Canvas {
  private readonly cells: Array<Array<Cell>>

  constructor(readonly width: number, readonly height: number, readonly base: CellStyle = {}) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: " ", style: base })))
  }

  /** Write `text` starting at (x, y); characters outside the canvas are dropped. */
  put(x: number, y: number, text: string, style: CellStyle = {}): this {
    const row = this.cells[y]
    if (row === undefined) return this
    let i = 0
    for (const ch of text) {
      const cell = row[x + i]
      if (cell !== undefined && x + i >= 0) {
        cell.ch = ch
        cell.style = { ...cell.style, ...style }
      }
      i++
    }
    return this
  }

  /** Text centred on column `cx`. */
  center(cx: number, y: number, text: string, style: CellStyle = {}): this {
    return this.put(cx - Math.floor([...text].length / 2), y, text, style)
  }

  /** Paint a rectangle's background without touching the characters. */
  fill(x: number, y: number, w: number, h: number, style: CellStyle): this {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        const cell = this.cells[j]?.[i]
        if (cell !== undefined) cell.style = { ...cell.style, ...style }
      }
    }
    return this
  }

  /** Rows of runs of identically styled text. */
  runs(): ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly style: CellStyle }>> {
    return this.cells.map((row) => {
      const out: Array<{ text: string; style: CellStyle }> = []
      for (const cell of row) {
        const last = out[out.length - 1]
        if (last !== undefined && sameStyle(last.style, cell.style)) last.text += cell.ch
        else out.push({ text: cell.ch, style: cell.style })
      }
      return out
    })
  }
}

const sameStyle = (a: CellStyle, b: CellStyle) => a.fg === b.fg && a.bg === b.bg && a.bold === b.bold

/** Render a canvas as one text line per row. */
export const CanvasView = ({ canvas }: { readonly canvas: Canvas }) => (
  <box flexDirection="column" width={canvas.width} height={canvas.height} flexShrink={0}>
    {canvas.runs().map((row, y) => (
      <text key={y} height={1}>
        {row.map((run, i) => (
          <span
            key={i}
            {...(run.style.fg !== undefined ? { fg: run.style.fg } : {})}
            {...(run.style.bg !== undefined ? { bg: run.style.bg } : {})}
            {...(run.style.bold ? { attributes: TextAttributes.BOLD } : {})}
          >
            {run.text}
          </span>
        ))}
      </text>
    ))}
  </box>
)
