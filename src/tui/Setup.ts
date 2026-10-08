/**
 * Pre-game setup: the teams, lineups and options a user fills in before the
 * first pitch, validated and turned into the Retrosheet records that open a
 * game (`id`, `info`, `start`).
 */
import { Data, Effect } from "effect"
import { RetroRecord, type Side } from "../retrosheet/Record.ts"

export interface LineupEntry {
  /** Player name as typed, e.g. "Aaron Judge". */
  readonly name: string
  /** Position as typed: a number (1-10) or an abbreviation (SS, CF, DH...). */
  readonly position: string
}

export interface TeamSetup {
  /** Team code, e.g. NYA. */
  readonly code: string
  /** Batting order slots 1-9. */
  readonly lineup: ReadonlyArray<LineupEntry>
  /** The starting pitcher when the team uses a DH (he doesn't bat). */
  readonly pitcher: string
}

export interface GameSetup {
  /** YYYY-MM-DD. */
  readonly date: string
  /** 0 for a single game, 1 or 2 for a doubleheader. */
  readonly gameNumber: number
  readonly useDH: boolean
  readonly innings: number
  readonly site: string
  /** Away, home. */
  readonly teams: readonly [TeamSetup, TeamSetup]
}

/** Where an issue is, so the form can point at the offending field. */
export type SetupField =
  | { readonly _tag: "Game"; readonly key: "date" | "innings" }
  | { readonly _tag: "Code"; readonly side: Side }
  | { readonly _tag: "Name"; readonly side: Side; readonly slot: number }
  | { readonly _tag: "Position"; readonly side: Side; readonly slot: number }
  | { readonly _tag: "Pitcher"; readonly side: Side }

export interface SetupIssue {
  readonly field: SetupField
  readonly message: string
}

export class SetupError extends Data.TaggedError("SetupError")<{
  readonly issues: ReadonlyArray<SetupIssue>
}> {
  override get message() {
    return this.issues.map((i) => i.message).join("; ")
  }
}

const positionNames: Readonly<Record<string, number>> = {
  P: 1,
  C: 2,
  "1B": 3,
  "2B": 4,
  "3B": 5,
  SS: 6,
  LF: 7,
  CF: 8,
  RF: 9,
  DH: 10,
  D: 10
}

/** Parse a typed position: `6`, `ss`, `DH`. */
export const parsePosition = (text: string): number | undefined => {
  const t = text.trim().toUpperCase()
  if (/^\d+$/.test(t)) {
    const n = Number(t)
    return n >= 1 && n <= 10 ? n : undefined
  }
  return positionNames[t]
}

const nameParts = (name: string) => {
  const words = name.trim().split(/\s+/).filter((w) => w !== "")
  const last = words.length > 1 ? words.slice(1).join("") : words[0] ?? ""
  const first = words.length > 1 ? words[0]! : ""
  return { first, last }
}

/**
 * A Retrosheet-style player id: first four letters of the last name, first
 * initial, and a three-digit number that makes it unique: "Aaron Judge" → judga001.
 */
export const makePlayerId = (name: string, taken: ReadonlySet<string>): string => {
  const { first, last } = nameParts(name)
  const letters = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "")
  const stem = (letters(last).slice(0, 4).padEnd(4, "-") + (letters(first)[0] ?? "-")).slice(0, 5)
  for (let n = 1; ; n++) {
    const id = `${stem}${String(n).padStart(3, "0")}`
    if (!taken.has(id)) return id
  }
}

const teamName = (side: Side) => (side === 0 ? "Away" : "Home")

export const validateSetup = (setup: GameSetup): ReadonlyArray<SetupIssue> => {
  const issues: Array<SetupIssue> = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(setup.date) || Number.isNaN(Date.parse(setup.date))) {
    issues.push({ field: { _tag: "Game", key: "date" }, message: "Date must be YYYY-MM-DD" })
  }
  if (!Number.isInteger(setup.innings) || setup.innings < 1 || setup.innings > 99) {
    issues.push({ field: { _tag: "Game", key: "innings" }, message: "Innings must be a positive number" })
  }
  const codes = setup.teams.map((t) => t.code.trim().toUpperCase())
  for (const side of [0, 1] as const) {
    const team = setup.teams[side]
    const label = teamName(side)
    const code = codes[side]!
    if (!/^[A-Z0-9]{2,4}$/.test(code)) {
      issues.push({ field: { _tag: "Code", side }, message: `${label} team code must be 2-4 letters (e.g. NYA)` })
    }
    const seen = new Map<number, number>()
    team.lineup.forEach((entry, i) => {
      const slot = i + 1
      if (entry.name.trim() === "") {
        issues.push({ field: { _tag: "Name", side, slot }, message: `${label} #${slot} needs a name` })
      }
      const pos = parsePosition(entry.position)
      if (pos === undefined) {
        issues.push({ field: { _tag: "Position", side, slot }, message: `${label} #${slot}: unknown position "${entry.position}"` })
        return
      }
      if (pos === 10 && !setup.useDH) {
        issues.push({ field: { _tag: "Position", side, slot }, message: `${label} #${slot}: DH, but the game has no DH` })
      }
      if (pos === 1 && setup.useDH) {
        issues.push({ field: { _tag: "Position", side, slot }, message: `${label} #${slot}: with a DH the pitcher doesn't bat` })
      }
      const other = seen.get(pos)
      if (other !== undefined) {
        issues.push({
          field: { _tag: "Position", side, slot },
          message: `${label} #${slot} and #${other} both play ${entry.position.toUpperCase()}`
        })
      }
      seen.set(pos, slot)
    })
    if (setup.useDH && team.pitcher.trim() === "") {
      issues.push({ field: { _tag: "Pitcher", side }, message: `${label} needs a starting pitcher` })
    }
  }
  if (codes[0] === codes[1] && codes[0] !== "") {
    issues.push({ field: { _tag: "Code", side: 1 }, message: "The two teams need different codes" })
  }
  return issues
}

/** The game id Retrosheet would use: home team, date, game number: NYA202604010. */
export const gameIdFor = (setup: GameSetup): string =>
  `${setup.teams[1].code.trim().toUpperCase()}${setup.date.replaceAll("-", "")}${setup.gameNumber}`

/** The records that open the game: id, info and start records for both lineups. */
export const setupRecords = (setup: GameSetup): Effect.Effect<ReadonlyArray<RetroRecord>, SetupError> =>
  Effect.suspend(() => {
    const issues = validateSetup(setup)
    if (issues.length > 0) return Effect.fail(new SetupError({ issues }))
    const info = (key: string, value: string) => RetroRecord.Info({ key, value })
    const records: Array<RetroRecord> = [
      RetroRecord.Id({ gameId: gameIdFor(setup) }),
      RetroRecord.Version({ version: "2" }),
      info("visteam", setup.teams[0].code.trim().toUpperCase()),
      info("hometeam", setup.teams[1].code.trim().toUpperCase()),
      ...(setup.site.trim() !== "" ? [info("site", setup.site.trim())] : []),
      info("date", setup.date.replaceAll("-", "/")),
      info("number", String(setup.gameNumber)),
      info("usedh", String(setup.useDH)),
      ...(setup.innings !== 9 ? [info("innings", String(setup.innings))] : [])
    ]
    const taken = new Set<string>()
    const start = (name: string, side: Side, battingOrder: number, position: number) => {
      const playerId = makePlayerId(name, taken)
      taken.add(playerId)
      records.push(RetroRecord.Start({ playerId, name: name.trim(), side, battingOrder, position }))
    }
    for (const side of [0, 1] as const) {
      const team = setup.teams[side]
      team.lineup.forEach((entry, i) => start(entry.name, side, i + 1, parsePosition(entry.position)!))
      if (setup.useDH) start(team.pitcher, side, 0, 1)
    }
    return Effect.succeed(records)
  })

export const emptyTeamSetup = (): TeamSetup => ({
  code: "",
  lineup: Array.from({ length: 9 }, () => ({ name: "", position: "" })),
  pitcher: ""
})

export const today = (): string => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const emptySetup = (): GameSetup => ({
  date: today(),
  gameNumber: 0,
  useDH: true,
  innings: 9,
  site: "",
  teams: [emptyTeamSetup(), emptyTeamSetup()]
})

const team = (code: string, lineup: ReadonlyArray<readonly [string, string]>, pitcher: string): TeamSetup => ({
  code,
  lineup: lineup.map(([name, position]) => ({ name, position })),
  pitcher
})

/** A filled-in example game (Giants at Yankees), handy for trying things out. */
export const exampleSetup = (): GameSetup => ({
  date: "2023-03-30",
  gameNumber: 0,
  useDH: true,
  innings: 9,
  site: "NYC21",
  teams: [
    team("SFN", [
      ["LaMonte Wade", "1B"],
      ["Joc Pederson", "DH"],
      ["Mitch Haniger", "RF"],
      ["Michael Conforto", "LF"],
      ["J.D. Davis", "3B"],
      ["Thairo Estrada", "2B"],
      ["Mike Yastrzemski", "CF"],
      ["Brandon Crawford", "SS"],
      ["Roberto Perez", "C"]
    ], "Logan Webb"),
    team("NYA", [
      ["Gleyber Torres", "2B"],
      ["Aaron Judge", "CF"],
      ["Giancarlo Stanton", "RF"],
      ["Anthony Rizzo", "1B"],
      ["Josh Donaldson", "3B"],
      ["Oswaldo Cabrera", "LF"],
      ["Anthony Volpe", "SS"],
      ["Kyle Higashioka", "C"],
      ["Aaron Hicks", "DH"]
    ], "Gerrit Cole")
  ]
})
