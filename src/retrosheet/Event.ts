/**
 * Parser for the event field of a Retrosheet `play` record, e.g.
 * `S8/G.2-H;1-3`, `64(1)3/GDP/G6`, `K+SB2`, `CS2(26)`, `FC5/G5.3XH(52);B-1`.
 *
 * The grammar is `basic[/modifier]*[.advance[;advance]*]`.
 */
import { Data, Effect } from "effect"
import type { Base } from "./Record.ts"

/** Where a runner starts: the batter or one of the bases. */
export type Origin = "B" | Base
/** Where a runner ends up: a base, or 4 for home. */
export type Dest = 1 | 2 | 3 | 4

export type HitKind = "Single" | "Double" | "Triple" | "HomeRun" | "GroundRuleDouble"

/** Events that only involve baserunners. They can stand alone or follow `K+`/`W+`. */
export type RunnerEvent = Data.TaggedEnum<{
  StolenBase: { readonly base: Dest }
  CaughtStealing: { readonly base: Dest; readonly fielders: string; readonly errored: boolean }
  Pickoff: { readonly base: Base; readonly fielders: string; readonly errored: boolean }
  PickoffCaughtStealing: { readonly base: Dest; readonly fielders: string; readonly errored: boolean }
  WildPitch: {}
  PassedBall: {}
  Balk: {}
  DefensiveIndifference: {}
  OtherAdvance: {}
  /** An error that follows a strikeout or walk (`K+E2`). */
  FieldingError: { readonly fielder: string }
}>
export const RunnerEvent = Data.taggedEnum<RunnerEvent>()

export interface Putout {
  /** The fielders handling the ball; the last one recorded the putout. */
  readonly fielders: string
  /** Who was put out. */
  readonly runner: Origin
}

export type BasicPlay = Data.TaggedEnum<{
  /** `8`, `63`, `64(1)3`, `8(B)84(2)` ... */
  FieldedOut: { readonly putouts: ReadonlyArray<Putout>; readonly batterOut: boolean }
  Hit: { readonly kind: HitKind; readonly fielders: string }
  /** `E6`, `5E3`: batter reached on an error. */
  ReachedOnError: { readonly fielders: string; readonly fielder: string }
  FieldersChoice: { readonly fielders: string }
  /** `FLE5`: error on a foul fly; the at bat continues. */
  FoulFlyError: { readonly fielder: string }
  Strikeout: { readonly fielders: string; readonly extra: ReadonlyArray<RunnerEvent> }
  Walk: { readonly intentional: boolean; readonly extra: ReadonlyArray<RunnerEvent> }
  HitByPitch: {}
  /** `C/E2`: catcher (or other fielder) interference. */
  Interference: { readonly fielder: string }
  /** `NP`: no play, usually a substitution marker. */
  NoPlay: {}
  /** `SB2`, `WP`, `CS3(25)`, `SB2;SB3` ... */
  RunnerOnly: { readonly events: ReadonlyArray<RunnerEvent> }
}>
export const BasicPlay = Data.taggedEnum<BasicPlay>()

export interface Advance {
  readonly from: Origin
  readonly to: Dest
  /** Written with `X` (thrown out attempting to advance). */
  readonly attemptedOut: boolean
  /** Actually out: `X` not negated by an error. */
  readonly out: boolean
  /** Raw parenthetical parameters, e.g. `["E5/TH", "NR", "UR"]`. */
  readonly params: ReadonlyArray<string>
}

export interface ParsedEvent {
  readonly raw: string
  readonly basic: BasicPlay
  readonly modifiers: ReadonlyArray<string>
  readonly advances: ReadonlyArray<Advance>
}

export class EventParseError extends Data.TaggedError("EventParseError")<{
  readonly event: string
  readonly message: string
}> {}

const fail = (event: string, message: string) => Effect.fail(new EventParseError({ event, message }))

/** Split `s` on `sep`, ignoring separators inside parentheses. */
const splitTopLevel = (s: string, sep: string): Array<string> => {
  const parts: Array<string> = []
  let depth = 0
  let current = ""
  for (const ch of s) {
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    if (ch === sep && depth === 0) {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/** Index of the first top-level `.` (start of the advance section), or -1. */
const advanceSeparator = (s: string): number => {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    else if (ch === "." && depth === 0) return i
  }
  return -1
}

const parseDest = (c: string): Dest | undefined =>
  c === "1" ? 1 : c === "2" ? 2 : c === "3" ? 3 : c === "H" ? 4 : undefined

const parseOrigin = (c: string): Origin | undefined =>
  c === "B" ? "B" : c === "1" ? 1 : c === "2" ? 2 : c === "3" ? 3 : undefined

const parseParams = (s: string): Array<string> => [...s.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!)

/** A fielding sequence parameter like `25`, `5E3`, `E5/TH`, `9`. */
const isFieldingParam = (p: string): boolean => /^\d*E?\d*(\/TH\d?H?)?$/.test(p) && /\d/.test(p)

/**
 * An `X` advance is negated (runner safe) when its fielding sequences all
 * contain an error, e.g. `1X3(5E3)` or `BX1(6E1)`. A putout sequence without
 * an error means the runner was out regardless: in `BX3(25)(E5/TH)` the error
 * is a separate throwing error, and in `1X2(4E6)(6)` the runner was put out
 * after the error.
 */
export const isOutNegated = (params: ReadonlyArray<string>): boolean => {
  const fielding = params.filter(isFieldingParam)
  return fielding.length > 0 && fielding.every((p) => p.includes("E"))
}

const containsError = (fielders: string) => fielders.includes("E")

const parseRunnerEvent = Effect.fnUntraced(function*(event: string, token: string) {
  switch (token) {
    case "WP":
      return RunnerEvent.WildPitch()
    case "PB":
      return RunnerEvent.PassedBall()
    case "BK":
      return RunnerEvent.Balk()
    case "DI":
      return RunnerEvent.DefensiveIndifference()
    case "OA":
      return RunnerEvent.OtherAdvance()
  }
  let m: RegExpMatchArray | null
  // Stolen bases may carry parameters like SBH(UR); they don't affect the state.
  if ((m = token.match(/^SB([23H])(?:\([^)]*\))*$/))) return RunnerEvent.StolenBase({ base: parseDest(m[1]!)! })
  if ((m = token.match(/^POCS([23H])((?:\([^)]*\))*)$/))) {
    const fielders = parseParams(m[2]!).join("")
    return RunnerEvent.PickoffCaughtStealing({
      base: parseDest(m[1]!)!,
      fielders,
      errored: containsError(fielders)
    })
  }
  if ((m = token.match(/^CS([23H])((?:\([^)]*\))*)$/))) {
    const fielders = parseParams(m[2]!).join("")
    return RunnerEvent.CaughtStealing({ base: parseDest(m[1]!)!, fielders, errored: containsError(fielders) })
  }
  if ((m = token.match(/^PO([123])((?:\([^)]*\))*)$/))) {
    const fielders = parseParams(m[2]!).join("")
    return RunnerEvent.Pickoff({ base: Number(m[1]) as Base, fielders, errored: containsError(fielders) })
  }
  if ((m = token.match(/^E(\d)$/))) return RunnerEvent.FieldingError({ fielder: m[1]! })
  return yield* fail(event, `unrecognized baserunning event "${token}"`)
})

const parseRunnerEvents = (event: string, s: string) =>
  Effect.forEach(splitTopLevel(s, ";").filter((t) => t !== ""), (t) => parseRunnerEvent(event, t))

const parseFieldedOut = Effect.fnUntraced(function*(event: string, basic: string) {
  const putouts: Array<Putout> = []
  let rest = basic
  while (rest.length > 0) {
    const m = rest.match(/^(\d+)(?:\(([B123])\))?/)
    if (!m) return yield* fail(event, `cannot parse fielding sequence "${basic}"`)
    const runner = m[2] === undefined ? undefined : parseOrigin(m[2])
    if (runner === undefined && m[0].length !== rest.length) {
      return yield* fail(event, `cannot parse fielding sequence "${basic}"`)
    }
    putouts.push({ fielders: m[1]!, runner: runner ?? "B" })
    rest = rest.slice(m[0].length)
  }
  return BasicPlay.FieldedOut({ putouts, batterOut: putouts.some((p) => p.runner === "B") })
})

const parseBasic = Effect.fnUntraced(function*(event: string, basic: string, modifiers: ReadonlyArray<string>) {
  let m: RegExpMatchArray | null
  if (basic === "NP") return BasicPlay.NoPlay()
  if (basic === "HP") return BasicPlay.HitByPitch()
  if (basic === "C") {
    const fielder = modifiers.map((x) => x.match(/^E(\d)/)?.[1]).find((x) => x !== undefined) ?? "2"
    return BasicPlay.Interference({ fielder })
  }
  if ((m = basic.match(/^(\d+)$/)) || /^\d+\([B123]\)/.test(basic)) return yield* parseFieldedOut(event, basic)
  if ((m = basic.match(/^(\d*)E(\d)$/))) return BasicPlay.ReachedOnError({ fielders: basic, fielder: m[2]! })
  if ((m = basic.match(/^FLE(\d)$/))) return BasicPlay.FoulFlyError({ fielder: m[1]! })
  if ((m = basic.match(/^FC(\d*)$/))) return BasicPlay.FieldersChoice({ fielders: m[1]! })
  if ((m = basic.match(/^DGR(\d*)$/))) return BasicPlay.Hit({ kind: "GroundRuleDouble", fielders: m[1]! })
  if ((m = basic.match(/^(?:HR|H)(\d*)$/))) return BasicPlay.Hit({ kind: "HomeRun", fielders: m[1]! })
  if ((m = basic.match(/^([SDT])(\d*)$/))) {
    const kind: HitKind = m[1] === "S" ? "Single" : m[1] === "D" ? "Double" : "Triple"
    return BasicPlay.Hit({ kind, fielders: m[2]! })
  }
  if ((m = basic.match(/^K(\d*)(?:\+(.+))?$/))) {
    const extra = m[2] === undefined ? [] : yield* parseRunnerEvents(event, m[2])
    return BasicPlay.Strikeout({ fielders: m[1]!, extra })
  }
  if ((m = basic.match(/^(IW|I|W)(?:\+(.+))?$/))) {
    const extra = m[2] === undefined ? [] : yield* parseRunnerEvents(event, m[2])
    return BasicPlay.Walk({ intentional: m[1] !== "W", extra })
  }
  const events = yield* parseRunnerEvents(event, basic).pipe(
    Effect.mapError(() => new EventParseError({ event, message: `unrecognized play "${basic}"` }))
  )
  if (events.some((e) => e._tag === "FieldingError")) return yield* fail(event, `unrecognized play "${basic}"`)
  return BasicPlay.RunnerOnly({ events })
})

const parseAdvance = Effect.fnUntraced(function*(event: string, token: string) {
  const m = token.match(/^([B123])([-X])([123H])((?:\([^)]*\))*)$/)
  if (!m) return yield* fail(event, `cannot parse advance "${token}" (expected e.g. 1-2, 2-H(E5), BX3(85))`)
  const from = parseOrigin(m[1]!)!
  const to = parseDest(m[3]!)!
  const params = parseParams(m[4]!)
  const attemptedOut = m[2] === "X"
  const fromNum = from === "B" ? 0 : from
  // `2-2` (runner holds) is legal; moving backwards is not.
  if (to < fromNum) return yield* fail(event, `advance "${token}" moves backwards`)
  return { from, to, attemptedOut, out: attemptedOut && !isOutNegated(params), params } satisfies Advance
})

/** Parse the event field of a play record. */
export const parseEvent = Effect.fnUntraced(function*(raw: string) {
  // `#`, `!` and `?` are annotations (uncertain / exceptional play) with no effect on the state.
  const event = raw.trim().replace(/[#!?]/g, "")
  if (event === "") return yield* fail(raw, "empty event")
  const dot = advanceSeparator(event)
  const head = dot === -1 ? event : event.slice(0, dot)
  const advanceText = dot === -1 ? "" : event.slice(dot + 1)
  const [basicText, ...modifiers] = splitTopLevel(head, "/")
  const basic = yield* parseBasic(raw, basicText!.toUpperCase(), modifiers)
  const advances = yield* Effect.forEach(
    advanceText.split(";").map((t) => t.trim()).filter((t) => t !== ""),
    (t) => parseAdvance(raw, t)
  )
  const seen = new Set<Origin>()
  for (const a of advances) {
    if (seen.has(a.from)) return yield* fail(raw, `runner ${a.from === "B" ? "B" : a.from} advances twice`)
    seen.add(a.from)
  }
  return { raw, basic, modifiers: modifiers.filter((x) => x !== ""), advances } satisfies ParsedEvent
})

/** Does the event complete the batter's plate appearance? */
export const endsPlateAppearance = (basic: BasicPlay): boolean =>
  basic._tag !== "NoPlay" && basic._tag !== "RunnerOnly" && basic._tag !== "FoulFlyError"
