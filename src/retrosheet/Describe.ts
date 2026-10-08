/**
 * Plain-English descriptions of parsed events.
 */
import type { BasicPlay, ParsedEvent, RunnerEvent } from "./Event.ts"
import { positionAbbrev } from "./Game.ts"

const fielderName = (c: string | undefined): string => {
  if (c === undefined || c === "") return ""
  const n = Number(c)
  return Number.isInteger(n) && n >= 1 && n <= 9 ? positionAbbrev(n) : "unknown fielder"
}

const seq = (fielders: string): string => fielders.split("").map(fielderName).join("-")

const baseName = (b: number): string => (b === 4 ? "home" : b === 1 ? "1st" : b === 2 ? "2nd" : "3rd")

const trajectories: Record<string, string> = {
  G: "ground ball",
  L: "line drive",
  F: "fly ball",
  P: "pop up",
  BG: "bunt ground ball",
  BP: "bunt pop up",
  BL: "bunt line drive",
  BF: "bunt fly",
  BGDP: "bunted into double play",
  BPDP: "bunt popped into double play",
  GDP: "grounded into double play",
  LDP: "lined into double play",
  FDP: "flied into double play",
  GTP: "grounded into triple play",
  LTP: "lined into triple play",
  SH: "sacrifice bunt",
  SF: "sacrifice fly",
  FO: "force out",
  IF: "infield fly",
  IPHR: "inside-the-park",
  TH: "throw",
  FL: "foul territory",
  INT: "interference",
  OBS: "obstruction",
  NDP: "no double play credited",
  DP: "double play",
  TP: "triple play",
  AP: "appeal play"
}

const describeModifier = (m: string): string | undefined => {
  const hit = m.match(/^(BG|BP|BL|BF|G|L|F|P)(\d+.*)?$/)
  if (hit) {
    const where = hit[2] === undefined ? "" : ` to ${hitLocation(hit[2])}`
    return `${trajectories[hit[1]!]}${where}`
  }
  return trajectories[m.replace(/\d+$/, "")]
}

const hitLocation = (loc: string): string => {
  const digits = loc.match(/^\d+/)?.[0] ?? ""
  if (digits.length === 1) return fielderName(digits)
  if (digits.length === 2) return `${fielderName(digits[0])}-${fielderName(digits[1])} gap`
  return loc
}

export const describeRunnerEvent = (e: RunnerEvent): string => {
  switch (e._tag) {
    case "StolenBase":
      return `stolen base (${baseName(e.base)})`
    case "CaughtStealing":
      return `${e.errored ? "caught stealing negated by error" : "caught stealing"} (${baseName(e.base)}${
        e.fielders ? `, ${seq(e.fielders.replace(/[^1-9]/g, ""))}` : ""
      })`
    case "Pickoff":
      return `${e.errored ? "pickoff attempt, error" : "picked off"} at ${baseName(e.base)}`
    case "PickoffCaughtStealing":
      return `${e.errored ? "pickoff/caught stealing negated by error" : "picked off, caught stealing"} (${
        baseName(e.base)
      })`
    case "WildPitch":
      return "wild pitch"
    case "PassedBall":
      return "passed ball"
    case "Balk":
      return "balk"
    case "DefensiveIndifference":
      return "defensive indifference"
    case "OtherAdvance":
      return "other advance"
    case "FieldingError":
      return `error by ${fielderName(e.fielder)}`
  }
}

const describeBasic = (b: BasicPlay, modifiers: ReadonlyArray<string>): string => {
  switch (b._tag) {
    case "FieldedOut": {
      const kind = modifiers.find((m) => /^(BG|BP|BL|BF|G|L|F|P)(\d|$)/.test(m))?.[0]
      const outs = b.putouts.length
      const verb = outs === 3 ? "Triple play" : outs === 2 ? "Double play" : b.putouts[0]!.fielders.length === 1
        ? kind === "G" ? "Ground out" : kind === "L" ? "Line out" : kind === "P" ? "Pop out" : "Fly out"
        : "Ground out"
      const lead = b.batterOut ? verb : `${verb === "Ground out" ? "Force out" : verb}, batter safe`
      return `${lead} (${b.putouts.map((p) => seq(p.fielders)).join(", ")})`
    }
    case "Hit": {
      const word = {
        Single: "Single",
        Double: "Double",
        Triple: "Triple",
        HomeRun: "Home run",
        GroundRuleDouble: "Ground-rule double"
      }[b.kind]
      return b.fielders ? `${word} to ${fielderName(b.fielders[0])}` : word
    }
    case "ReachedOnError":
      return `Reached on error by ${fielderName(b.fielder)}`
    case "FieldersChoice":
      return b.fielders ? `Fielder's choice (${seq(b.fielders)})` : "Fielder's choice"
    case "FoulFlyError":
      return `Error by ${fielderName(b.fielder)} on foul fly`
    case "Strikeout":
      return ["Strikeout", ...b.extra.map(describeRunnerEvent)].join(" + ")
    case "Walk":
      return [b.intentional ? "Intentional walk" : "Walk", ...b.extra.map(describeRunnerEvent)].join(" + ")
    case "HitByPitch":
      return "Hit by pitch"
    case "Interference":
      return `Reached on interference by ${fielderName(b.fielder)}`
    case "NoPlay":
      return "No play"
    case "RunnerOnly": {
      const text = b.events.map(describeRunnerEvent).join(", ")
      return text.charAt(0).toUpperCase() + text.slice(1)
    }
  }
}

/** Describe the batter's part of an event, e.g. "Single to CF (ground ball to SS-2B gap)". */
export const describeEvent = (e: ParsedEvent): string => {
  const base = describeBasic(e.basic, e.modifiers)
  const mods = e.modifiers
    .filter((m) => !/^E\d/.test(m))
    .map(describeModifier)
    .filter((m): m is string => m !== undefined)
  return mods.length > 0 ? `${base} [${mods.join(", ")}]` : base
}

export { baseName }
