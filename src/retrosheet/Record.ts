/**
 * Parsing of individual lines of a Retrosheet event file into typed records.
 *
 * See https://www.retrosheet.org/eventfile.htm for the format.
 */
import { Data, Effect } from "effect"

/** 0 = visiting team, 1 = home team. */
export type Side = 0 | 1

/** A base a runner can occupy. */
export type Base = 1 | 2 | 3

export interface Count {
  readonly balls: number
  readonly strikes: number
}

export type RetroRecord = Data.TaggedEnum<{
  Id: { readonly gameId: string }
  Version: { readonly version: string }
  Info: { readonly key: string; readonly value: string }
  Start: Appearance
  Sub: Appearance
  Play: {
    readonly inning: number
    readonly side: Side
    readonly playerId: string
    /** `undefined` when the count is unknown (`??`). */
    readonly count: Count | undefined
    readonly pitches: string
    readonly event: string
  }
  Comment: { readonly text: string }
  Data: { readonly kind: string; readonly playerId: string; readonly value: string }
  BatterAdj: { readonly playerId: string; readonly hand: string }
  PitcherAdj: { readonly playerId: string; readonly hand: string }
  LineupAdj: { readonly side: Side; readonly slot: number }
  RunnerAdj: { readonly playerId: string; readonly base: Base }
  PitcherResponsibilityAdj: { readonly playerId: string; readonly base: Base }
}>

export interface Appearance {
  readonly playerId: string
  readonly name: string
  readonly side: Side
  /** 1-9, or 0 for a pitcher who does not bat (DH games). */
  readonly battingOrder: number
  /** 1-9 fielding positions, 10 = DH, 11 = pinch hitter, 12 = pinch runner. */
  readonly position: number
}

export const RetroRecord = Data.taggedEnum<RetroRecord>()

export class RecordParseError extends Data.TaggedError("RecordParseError")<{
  readonly line: string
  readonly message: string
}> {}

/** The record keywords that begin a line of an event file. */
export const recordKeywords = [
  "id",
  "version",
  "info",
  "start",
  "sub",
  "play",
  "com",
  "data",
  "badj",
  "padj",
  "ladj",
  "radj",
  "presadj"
] as const

export type RecordKeyword = (typeof recordKeywords)[number]

export const isRecordKeyword = (s: string): s is RecordKeyword =>
  (recordKeywords as ReadonlyArray<string>).includes(s)

/** Does this line look like a Retrosheet record (`keyword,...`)? */
export const looksLikeRecord = (line: string): boolean => {
  const comma = line.indexOf(",")
  return comma > 0 && isRecordKeyword(line.slice(0, comma).trim().toLowerCase())
}

/** Split a CSV line, honouring double-quoted fields (which may contain commas). */
export const splitFields = (line: string): Array<string> => {
  const fields: Array<string> = []
  let current = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\""
        i++
      } else {
        quoted = !quoted
      }
    } else if (ch === "," && !quoted) {
      fields.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

/** Quote a field for output if needed. */
export const quoteField = (s: string): string => `"${s.replaceAll("\"", "\"\"")}"`

const fail = (line: string, message: string) => Effect.fail(new RecordParseError({ line, message }))

const parseIntField = (line: string, value: string | undefined, what: string) => {
  const v = value?.trim() ?? ""
  return /^-?\d+$/.test(v) ? Effect.succeed(Number(v)) : fail(line, `${what} must be an integer, got "${v}"`)
}

const parseSide = (line: string, value: string | undefined) =>
  Effect.flatMap(parseIntField(line, value, "team"), (n) =>
    n === 0 || n === 1 ? Effect.succeed(n as Side) : fail(line, `team must be 0 (visitor) or 1 (home), got ${n}`))

const parseBase = (line: string, value: string | undefined) =>
  Effect.flatMap(parseIntField(line, value, "base"), (n) =>
    n === 1 || n === 2 || n === 3 ? Effect.succeed(n as Base) : fail(line, `base must be 1, 2 or 3, got ${n}`))

const requireFields = (line: string, fields: ReadonlyArray<string>, n: number, usage: string) =>
  fields.length < n ? fail(line, `expected ${n} fields: ${usage}`) : Effect.void

const parseCount = (line: string, raw: string): Effect.Effect<Count | undefined, RecordParseError> => {
  const v = raw.trim()
  if (v === "" || v === "??") return Effect.succeed(undefined)
  if (/^[0-3?][0-2?]$/.test(v)) {
    const [b, s] = [v[0]!, v[1]!]
    if (b === "?" || s === "?") return Effect.succeed(undefined)
    return Effect.succeed({ balls: Number(b), strikes: Number(s) })
  }
  return fail(line, `count must be two digits (balls, strikes) or ??, got "${v}"`)
}

const parseAppearance = Effect.fnUntraced(function*(line: string, fields: ReadonlyArray<string>) {
  yield* requireFields(line, fields, 6, `${fields[0]},playerid,"name",team,battingorder,position`)
  const playerId = fields[1]!.trim()
  if (playerId === "") return yield* fail(line, "player id is empty")
  const side = yield* parseSide(line, fields[3])
  const battingOrder = yield* parseIntField(line, fields[4], "batting order")
  if (battingOrder < 0 || battingOrder > 9) return yield* fail(line, `batting order must be 0-9, got ${battingOrder}`)
  const position = yield* parseIntField(line, fields[5], "position")
  if (position < 1 || position > 12) return yield* fail(line, `position must be 1-12, got ${position}`)
  return { playerId, name: fields[2]!.trim(), side, battingOrder, position } satisfies Appearance
})

/** Parse one line of an event file. Blank lines are not records; callers should skip them. */
export const parseRecord = Effect.fnUntraced(function*(rawLine: string) {
  const line = rawLine.replace(/\r$/, "")
  const fields = splitFields(line)
  const keyword = fields[0]!.trim().toLowerCase()
  switch (keyword) {
    case "id": {
      yield* requireFields(line, fields, 2, "id,gameid")
      return RetroRecord.Id({ gameId: fields[1]!.trim() })
    }
    case "version":
      return RetroRecord.Version({ version: (fields[1] ?? "").trim() })
    case "info": {
      yield* requireFields(line, fields, 2, "info,key,value")
      return RetroRecord.Info({ key: fields[1]!.trim(), value: fields.slice(2).join(",").trim() })
    }
    case "start":
      return RetroRecord.Start(yield* parseAppearance(line, fields))
    case "sub":
      return RetroRecord.Sub(yield* parseAppearance(line, fields))
    case "play": {
      yield* requireFields(line, fields, 7, "play,inning,team,playerid,count,pitches,event")
      const inning = yield* parseIntField(line, fields[1], "inning")
      if (inning < 1) return yield* fail(line, `inning must be positive, got ${inning}`)
      const side = yield* parseSide(line, fields[2])
      const playerId = fields[3]!.trim()
      const count = yield* parseCount(line, fields[4]!)
      const event = fields.slice(6).join(",").trim()
      if (event === "") return yield* fail(line, "event is empty")
      return RetroRecord.Play({ inning, side, playerId, count, pitches: fields[5]!.trim(), event })
    }
    case "com":
      return RetroRecord.Comment({ text: fields.slice(1).join(",") })
    case "data": {
      yield* requireFields(line, fields, 4, "data,er,playerid,value")
      return RetroRecord.Data({ kind: fields[1]!.trim(), playerId: fields[2]!.trim(), value: fields[3]!.trim() })
    }
    case "badj":
    case "padj": {
      yield* requireFields(line, fields, 3, `${keyword},playerid,hand`)
      const args = { playerId: fields[1]!.trim(), hand: fields[2]!.trim() }
      return keyword === "badj" ? RetroRecord.BatterAdj(args) : RetroRecord.PitcherAdj(args)
    }
    case "ladj": {
      yield* requireFields(line, fields, 3, "ladj,team,battingorder")
      const side = yield* parseSide(line, fields[1])
      const slot = yield* parseIntField(line, fields[2], "batting order")
      if (slot < 1 || slot > 9) return yield* fail(line, `batting order must be 1-9, got ${slot}`)
      return RetroRecord.LineupAdj({ side, slot })
    }
    case "radj":
    case "presadj": {
      yield* requireFields(line, fields, 3, `${keyword},playerid,base`)
      const args = { playerId: fields[1]!.trim(), base: yield* parseBase(line, fields[2]) }
      return keyword === "radj" ? RetroRecord.RunnerAdj(args) : RetroRecord.PitcherResponsibilityAdj(args)
    }
    default:
      return yield* fail(line, `unknown record type "${fields[0]}"`)
  }
})

/** Render a record back into event-file syntax. */
export const formatRecord = (record: RetroRecord): string => {
  switch (record._tag) {
    case "Id":
      return `id,${record.gameId}`
    case "Version":
      return `version,${record.version}`
    case "Info":
      return `info,${record.key},${record.value}`
    case "Start":
    case "Sub":
      return `${record._tag === "Start" ? "start" : "sub"},${record.playerId},${
        quoteField(record.name)
      },${record.side},${record.battingOrder},${record.position}`
    case "Play": {
      const count = record.count === undefined ? "??" : `${record.count.balls}${record.count.strikes}`
      return `play,${record.inning},${record.side},${record.playerId},${count},${record.pitches},${record.event}`
    }
    case "Comment":
      return `com,${record.text}`
    case "Data":
      return `data,${record.kind},${record.playerId},${record.value}`
    case "BatterAdj":
      return `badj,${record.playerId},${record.hand}`
    case "PitcherAdj":
      return `padj,${record.playerId},${record.hand}`
    case "LineupAdj":
      return `ladj,${record.side},${record.slot}`
    case "RunnerAdj":
      return `radj,${record.playerId},${record.base}`
    case "PitcherResponsibilityAdj":
      return `presadj,${record.playerId},${record.base}`
  }
}
