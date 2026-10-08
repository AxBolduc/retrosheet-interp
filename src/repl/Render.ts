/**
 * Text views of a game for the REPL.
 */
import {
  type Bases,
  currentBatterId,
  currentPitcherId,
  dueUp,
  type GameState,
  halfName,
  infoValue,
  ordinal,
  otherSide,
  type PlayLogEntry,
  playerName,
  positionAbbrev,
  teamCode
} from "../retrosheet/Game.ts"
import type { Side } from "../retrosheet/Record.ts"

export interface Style {
  readonly bold: (s: string) => string
  readonly dim: (s: string) => string
  readonly green: (s: string) => string
  readonly red: (s: string) => string
  readonly yellow: (s: string) => string
  readonly cyan: (s: string) => string
}

const ansi = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`

export const colorStyle: Style = {
  bold: ansi(1),
  dim: ansi(2),
  green: ansi(32),
  red: ansi(31),
  yellow: ansi(33),
  cyan: ansi(36)
}

export const plainStyle: Style = {
  bold: (s) => s,
  dim: (s) => s,
  green: (s) => s,
  red: (s) => s,
  yellow: (s) => s,
  cyan: (s) => s
}

// eslint-disable-next-line no-control-regex
const visibleLength = (s: string) => s.replace(/\x1b\[\d+m/g, "").length
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleLength(s)))
const padLeft = (s: string, n: number) => " ".repeat(Math.max(0, n - visibleLength(s))) + s

export const sideLabel = (game: GameState, side: Side) => `${teamCode(game, side)} (${side === 0 ? "away" : "home"})`

const runnerName = (game: GameState, bases: Bases, i: 0 | 1 | 2) => {
  const r = bases[i]
  return r === undefined ? "—" : playerName(game, r.playerId)
}

/** A small ASCII diamond showing occupied bases. */
const diamond = (bases: Bases, st: Style): ReadonlyArray<string> => {
  const mark = (i: 0 | 1 | 2) => (bases[i] ? st.yellow("◆") : st.dim("◇"))
  return [`    ${mark(1)}    `, `  ╱   ╲  `, `${mark(2)}       ${mark(0)}`, `  ╲   ╱  `, `    ⌂    `]
}

const outsDots = (outs: number, st: Style) => st.red("●".repeat(outs)) + st.dim("○".repeat(Math.max(0, 3 - outs)))

export const renderScoreLine = (game: GameState, st: Style): string =>
  `${teamCode(game, 0)} ${st.bold(String(game.score[0]))}  ${teamCode(game, 1)} ${st.bold(String(game.score[1]))}`

/** One-line situation summary shown after each play. */
export const renderSituation = (game: GameState, st: Style): string => {
  if (game.phase === "final") return `${st.bold("Final")}: ${renderScoreLine(game, st)}`
  const occupied = game.bases.map((r, i) => (r ? `${i + 1}B` : "")).filter((x) => x !== "")
  const bases = occupied.length === 0 ? "bases empty" : occupied.length === 3 ? "bases loaded" : occupied.join(" ")
  const batter = currentBatterId(game)
  return `${st.cyan(halfName(game))}, ${game.outs} out, ${bases} | ${renderScoreLine(game, st)} | up: ${
    playerName(game, batter)
  }`
}

export const renderState = (game: GameState, st: Style): string => {
  const lines: Array<string> = []
  const title = game.gameId ? `Game ${game.gameId}` : "Game"
  const date = infoValue(game, "date")
  lines.push(st.bold(`${title}${date ? ` — ${date}` : ""}`) + `  ${sideLabel(game, 0)} @ ${sideLabel(game, 1)}`)
  if (game.phase === "final") {
    lines.push(`${st.bold("FINAL")}  ${renderScoreLine(game, st)}`)
    return lines.join("\n")
  }
  lines.push(
    `${st.cyan(halfName(game))}${game.phase === "pregame" ? st.dim(" (not started)") : ""}   Outs: ${
      outsDots(game.outs, st)
    }   ${renderScoreLine(game, st)}`
  )
  const d = diamond(game.bases, st)
  const info = [
    `1B: ${runnerName(game, game.bases, 0)}`,
    `2B: ${runnerName(game, game.bases, 1)}`,
    `3B: ${runnerName(game, game.bases, 2)}`,
    "",
    ""
  ]
  for (let i = 0; i < d.length; i++) lines.push(`  ${d[i]}   ${info[i]}`)

  const batting = game.battingSide
  const team = game.teams[batting]
  const batterId = currentBatterId(game)
  const pitcherId = currentPitcherId(game)
  const pitcherLine = pitcherId ? game.pitching[pitcherId] : undefined
  lines.push(
    `At bat:   ${st.bold(playerName(game, batterId))} (${teamCode(game, batting)}, #${team.nextSlot}, ${
      positionAbbrev(batterId ? team.positions[batterId] : undefined)
    })${
      game.currentCount
        ? `  count ${game.currentCount.balls}-${game.currentCount.strikes}`
        : ""
    }`
  )
  const deck = dueUp(game, batting, 3).slice(1)
  lines.push(`On deck:  ${deck.map((x) => playerName(game, x.playerId)).join(", then ")}`)
  lines.push(
    `Pitching: ${st.bold(playerName(game, pitcherId))} (${teamCode(game, otherSide(batting))})${
      pitcherLine ? st.dim(`  ${formatIp(pitcherLine.outs)} IP, ${pitcherLine.bf} BF, ${pitcherLine.so} K`) : ""
    }`
  )
  const last = game.plays[game.plays.length - 1]
  if (last) lines.push(st.dim(`Last play: ${playerName(game, last.batterId)} — ${last.event} — ${last.description}`))
  return lines.join("\n")
}

export const renderLineup = (game: GameState, side: Side, st: Style): string => {
  const team = game.teams[side]
  const isBatting = game.battingSide === side && game.phase !== "final"
  const lines = [
    st.bold(`${sideLabel(game, side)}${isBatting ? " — batting" : game.phase === "final" ? "" : " — in the field"}`)
  ]
  lines.push(st.dim(" #  Player                     Pos   AB  R  H RBI BB  K"))
  for (let slot = 1; slot <= 9; slot++) {
    const id = team.lineup[slot]
    const b = id ? game.batting[id] : undefined
    const pos = positionAbbrev(id ? team.positions[id] : undefined)
    const marker = isBatting && team.nextSlot === slot ? st.yellow(" ◀ up") : ""
    const stats = b
      ? [b.ab, b.r, b.h, b.rbi, b.bb, b.so].map((n, i) => padLeft(String(n), i === 3 ? 4 : i === 0 ? 3 : 3)).join("")
      : ""
    lines.push(`${padLeft(String(slot), 2)}  ${pad(id ? playerName(game, id) : st.dim("(empty)"), 26)} ${pad(pos, 4)}${stats}${marker}`)
  }
  if (team.lineup[0]) {
    lines.push(` P  ${pad(playerName(game, team.lineup[0]), 26)} ${pad("P", 4)}${st.dim("  (not batting, DH in use)")}`)
  }
  const removed = team.removed.map((id) => playerName(game, id))
  if (removed.length > 0) lines.push(st.dim(`Out of the game: ${removed.join(", ")}`))
  return lines.join("\n")
}

export const renderDefense = (game: GameState, side: Side, st: Style): string => {
  const team = game.teams[side]
  const lines = [st.bold(`${sideLabel(game, side)} defense`)]
  for (let pos = 1; pos <= 9; pos++) {
    lines.push(`  ${pad(positionAbbrev(pos), 3)} ${playerName(game, team.fielders[pos])}`)
  }
  if (team.fielders[10]) lines.push(`  ${pad("DH", 3)} ${playerName(game, team.fielders[10])}`)
  if (team.pitchers.length > 1) {
    lines.push(st.dim(`  Pitchers used: ${team.pitchers.map((id) => playerName(game, id)).join(", ")}`))
  }
  return lines.join("\n")
}

export const renderLineScore = (game: GameState, st: Style): string => {
  const innings = Math.max(game.scheduledInnings, game.lineScore[0].length, game.lineScore[1].length)
  const header = `${pad("", 8)}${
    Array.from({ length: innings }, (_, i) => padLeft(String(i + 1), 3)).join("")
  }  ${padLeft("R", 3)}${padLeft("H", 3)}${padLeft("E", 3)}${padLeft("LOB", 5)}`
  const row = (side: Side) => {
    const runs = game.lineScore[side]
    const cells = Array.from({ length: innings }, (_, i) => {
      const r = runs[i]
      if (r !== undefined) return padLeft(String(r), 3)
      // Home team did not need to bat in the last inning.
      const skipped = side === 1 && game.phase === "final" && i === game.lineScore[0].length - 1
      return padLeft(skipped ? "X" : "", 3)
    })
    return `${pad(teamCode(game, side), 8)}${cells.join("")}  ${padLeft(st.bold(String(game.score[side])), 3)}${
      padLeft(String(game.hits[side]), 3)
    }${padLeft(String(game.errors[otherSide(side)]), 3)}${padLeft(String(game.leftOnBase[side]), 5)}`
  }
  return [st.dim(header), row(0), row(1)].join("\n")
}

const formatIp = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`

export const renderBox = (game: GameState, side: Side, st: Style): string => {
  const team = game.teams[side]
  const lines = [st.bold(`${sideLabel(game, side)} batting`)]
  lines.push(st.dim(`${pad("Player", 26)}${["Pos", "PA", "AB", "R", "H", "2B", "3B", "HR", "RBI", "BB", "K", "SB"].map((h, i) => padLeft(h, i === 0 ? 4 : 4)).join("")}`))
  const slotOf = (id: string) => team.battingSlots[id] ?? 10
  const batters = team.appeared
    .filter((id) => game.batting[id] && (game.batting[id]!.pa > 0 || team.lineup.slice(1).includes(id)))
    .sort((a, b) => slotOf(a) - slotOf(b))
  const totals = { pa: 0, ab: 0, r: 0, h: 0, d: 0, t: 0, hr: 0, rbi: 0, bb: 0, so: 0, sb: 0 }
  for (const id of batters) {
    const b = game.batting[id]!
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += b[k]
    const pos = team.positions[id]
    const sub = team.appeared.findIndex((x) => slotOf(x) === slotOf(id)) !== team.appeared.indexOf(id)
    lines.push(
      `${pad(`${sub ? "  " : ""}${playerName(game, id)}`, 26)}${padLeft(positionAbbrev(pos), 4)}${
        [b.pa, b.ab, b.r, b.h, b.d, b.t, b.hr, b.rbi, b.bb, b.so, b.sb].map((n) => padLeft(String(n), 4)).join("")
      }`
    )
  }
  lines.push(
    st.bold(`${pad("Totals", 26)}${padLeft("", 4)}${
      [totals.pa, totals.ab, totals.r, totals.h, totals.d, totals.t, totals.hr, totals.rbi, totals.bb, totals.so, totals.sb]
        .map((n) => padLeft(String(n), 4)).join("")
    }`)
  )
  lines.push("")
  lines.push(st.bold(`${sideLabel(game, side)} pitching`))
  lines.push(st.dim(`${pad("Pitcher", 26)}${["IP", "BF", "H", "R", "ER", "BB", "K", "HR", "WP"].map((h) => padLeft(h, 5)).join("")}`))
  for (const id of team.pitchers) {
    const p = game.pitching[id]
    if (!p) continue
    lines.push(
      `${pad(playerName(game, id), 26)}${
        [formatIp(p.outs), p.bf, p.h, p.r, p.er ?? "-", p.bb, p.so, p.hr, p.wp].map((n) => padLeft(String(n), 5)).join("")
      }`
    )
  }
  return lines.join("\n")
}

const basesShort = (bases: Bases) => bases.map((r, i) => (r ? String(i + 1) : "-")).join("")

export const renderPlay = (game: GameState, p: PlayLogEntry, st: Style): string => {
  const half = `${p.battingSide === 0 ? "T" : "B"}${p.inning}`
  const runs = p.runsScored.length > 0 ? st.green(` +${p.runsScored.length}`) : ""
  return `${st.dim(padLeft(String(p.number), 3))} ${pad(half, 4)}${p.outsBefore}o ${basesShort(p.basesBefore)}  ${
    pad(playerName(game, p.batterId), 22)
  } ${pad(st.cyan(p.event), 22)} ${p.description}${runs}`
}

export const renderPlays = (game: GameState, n: number, st: Style): string => {
  const plays = game.plays.slice(Math.max(0, game.plays.length - n))
  if (plays.length === 0) return st.dim("No plays yet.")
  const out: Array<string> = []
  let lastHalf = ""
  for (const p of plays) {
    const half = `${p.battingSide === 0 ? "Top" : "Bottom"} ${ordinal(p.inning)}`
    if (half !== lastHalf) {
      out.push(st.bold(`— ${half} —`))
      lastHalf = half
    }
    out.push(renderPlay(game, p, st))
  }
  return out.join("\n")
}

export const renderInfo = (game: GameState, st: Style): string => {
  const lines = [st.bold(`Game ${game.gameId ?? "(no id)"}`)]
  if (game.version) lines.push(`  version: ${game.version}`)
  for (const [k, v] of game.info) if (v !== "") lines.push(`  ${pad(k, 12)} ${v}`)
  if (game.notes.length > 0) {
    lines.push(st.bold("Notes"))
    for (const n of game.notes) lines.push(`  ${n}`)
  }
  if (game.comments.length > 0) {
    lines.push(st.bold("Comments"))
    for (const c of game.comments) lines.push(`  ${st.dim(`after play ${c.afterPlay}:`)} ${c.text}`)
  }
  return lines.join("\n")
}

export const renderRoster = (game: GameState, st: Style): string => {
  const lines: Array<string> = []
  for (const side of [0, 1] as const) {
    const team = game.teams[side]
    lines.push(st.bold(sideLabel(game, side)))
    for (const id of team.appeared) {
      const status = team.removed.includes(id) ? st.dim("out of game") : positionAbbrev(team.positions[id])
      lines.push(`  ${pad(id, 10)} ${pad(playerName(game, id), 26)} ${status}`)
    }
  }
  return lines.join("\n")
}
