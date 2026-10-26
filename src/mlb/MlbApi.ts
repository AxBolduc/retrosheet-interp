/**
 * Games from the MLB Stats API (statsapi.mlb.com, the data behind mlb.com):
 * the schedule for a day, and for one game everything the setup form needs —
 * teams, park, starting lineups with positions, starting pitchers and the
 * rest of both rosters.
 */
import { Context, Data, Effect, flow, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { Side } from "../retrosheet/Record.ts"
import { emptyTeamSetup, type GameSetup, type RosterPlayer, type TeamSetup } from "../tui/Setup.ts"
import { retrosheetParkId, retrosheetTeamCode } from "./Codes.ts"

// ---------------------------------------------------------------------------
// The parts of the API's responses we use
// ---------------------------------------------------------------------------

const Person = Schema.Struct({ id: Schema.Number, fullName: Schema.String })

const Position = Schema.Struct({ code: Schema.String, abbreviation: Schema.String })

const Team = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  abbreviation: Schema.optionalKey(Schema.String)
})

const Venue = Schema.Struct({ id: Schema.Number, name: Schema.String })

const ScheduleTeam = Schema.Struct({
  team: Team,
  probablePitcher: Schema.optionalKey(Person),
  score: Schema.optionalKey(Schema.Number)
})

const ScheduleGame = Schema.Struct({
  gamePk: Schema.Number,
  gameDate: Schema.String,
  officialDate: Schema.String,
  status: Schema.Struct({ detailedState: Schema.String, abstractGameState: Schema.String }),
  teams: Schema.Struct({ away: ScheduleTeam, home: ScheduleTeam }),
  venue: Venue,
  doubleHeader: Schema.String,
  gameNumber: Schema.Number,
  seriesDescription: Schema.optionalKey(Schema.String)
})

const ScheduleResponse = Schema.Struct({
  dates: Schema.Array(Schema.Struct({ games: Schema.Array(ScheduleGame) }))
})

const BoxPlayer = Schema.Struct({
  person: Person,
  jerseyNumber: Schema.optionalKey(Schema.String),
  position: Position,
  /** "100" for the leadoff starter, "101" for his first substitute, and so on. */
  battingOrder: Schema.optionalKey(Schema.String),
  allPositions: Schema.optionalKey(Schema.Array(Position))
})

const BoxTeam = Schema.Struct({
  team: Team,
  battingOrder: Schema.Array(Schema.Number),
  pitchers: Schema.Array(Schema.Number),
  bench: Schema.Array(Schema.Number),
  bullpen: Schema.Array(Schema.Number),
  /** Keyed by "ID<person id>". */
  players: Schema.Record(Schema.String, BoxPlayer)
})

const OptionalPerson = Schema.optionalKey(Person)

export const GameFeed = Schema.Struct({
  gameData: Schema.Struct({
    game: Schema.Struct({
      pk: Schema.Number,
      doubleHeader: Schema.String,
      gameNumber: Schema.Number,
      season: Schema.String
    }),
    datetime: Schema.Struct({ officialDate: Schema.String }),
    status: Schema.Struct({ detailedState: Schema.String }),
    teams: Schema.Struct({ away: Team, home: Team }),
    venue: Venue,
    probablePitchers: Schema.optionalKey(Schema.Struct({ away: OptionalPerson, home: OptionalPerson }))
  }),
  liveData: Schema.Struct({
    linescore: Schema.optionalKey(Schema.Struct({ scheduledInnings: Schema.optionalKey(Schema.Number) })),
    boxscore: Schema.Struct({ teams: Schema.Struct({ away: BoxTeam, home: BoxTeam }) })
  })
})
export type GameFeed = typeof GameFeed.Type

// ---------------------------------------------------------------------------
// What we hand to the UI
// ---------------------------------------------------------------------------

export interface ScheduledTeam {
  /** Retrosheet team code, e.g. NYA. */
  readonly code: string
  readonly name: string
  readonly probablePitcher: string | undefined
  readonly score: number | undefined
}

export interface ScheduledGame {
  readonly gamePk: number
  /** First pitch, ISO 8601. */
  readonly start: string
  /** YYYY-MM-DD. */
  readonly date: string
  /** "Scheduled", "Pre-Game", "In Progress", "Final"... */
  readonly status: string
  readonly isFinal: boolean
  readonly venue: string
  /** 0 for a single game, 1 or 2 for a doubleheader. */
  readonly gameNumber: number
  readonly description: string | undefined
  readonly teams: readonly [ScheduledTeam, ScheduledTeam]
}

export interface MlbGame {
  readonly gamePk: number
  readonly setup: GameSetup
  readonly status: string
  /** Whether each team's starting lineup has been announced. */
  readonly lineupsPosted: readonly [boolean, boolean]
}

export class MlbApiError extends Data.TaggedError("MlbApiError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const gameNumberOf = (doubleHeader: string, gameNumber: number) => (doubleHeader === "N" ? 0 : gameNumber)

const seasonOf = (date: string) => Number(date.slice(0, 4))

export const toScheduledGames = (response: typeof ScheduleResponse.Type): ReadonlyArray<ScheduledGame> =>
  response.dates.flatMap((d) =>
    d.games.map((g): ScheduledGame => {
      const team = (t: typeof ScheduleTeam.Type): ScheduledTeam => ({
        code: retrosheetTeamCode(t.team.id, t.team.abbreviation ?? t.team.name, seasonOf(g.officialDate)),
        name: t.team.name,
        probablePitcher: t.probablePitcher?.fullName,
        score: t.score
      })
      return {
        gamePk: g.gamePk,
        start: g.gameDate,
        date: g.officialDate,
        status: g.status.detailedState,
        isFinal: g.status.abstractGameState === "Final",
        venue: g.venue.name,
        gameNumber: gameNumberOf(g.doubleHeader, g.gameNumber),
        description: g.seriesDescription,
        teams: [team(g.teams.away), team(g.teams.home)]
      }
    })
  )

/** The starting batting order slot, 1-9, of a player who started the game. */
const startingSlot = (p: typeof BoxPlayer.Type): number | undefined => {
  const order = Number(p.battingOrder)
  return Number.isInteger(order) && order % 100 === 0 && order >= 100 && order <= 900 ? order / 100 : undefined
}

const byName = (a: RosterPlayer, b: RosterPlayer) => a.name.localeCompare(b.name)

const teamSetup = (
  box: typeof BoxTeam.Type,
  probable: typeof Person.Type | undefined,
  season: number
): { readonly team: TeamSetup; readonly posted: boolean } => {
  const players = Object.values(box.players)
  const starters = players
    .flatMap((p) => {
      const slot = startingSlot(p)
      return slot === undefined ? [] : [{ slot, player: p }]
    })
    .sort((a, b) => a.slot - b.slot)
  const posted = starters.length === 9
  const startingPosition = (p: typeof BoxPlayer.Type) => (p.allPositions?.[0] ?? p.position).abbreviation
  const lineup = posted
    ? starters.map(({ player }) => ({ name: player.person.fullName, position: startingPosition(player) }))
    : emptyTeamSetup().lineup
  const starterId = box.pitchers[0] ?? probable?.id
  const pitcher = (starterId === undefined ? undefined : box.players[`ID${starterId}`]?.person.fullName) ??
    probable?.fullName ?? ""
  const inLineup = new Set(posted ? starters.map((s) => s.player.person.id) : [])
  const bullpen = new Set(box.bullpen)
  const roster = players.map((p): RosterPlayer => ({
    name: p.person.fullName,
    position: p.position.abbreviation,
    jersey: p.jerseyNumber ?? "",
    role: inLineup.has(p.person.id)
      ? "lineup"
      : p.person.id === starterId
      ? "starter"
      : bullpen.has(p.person.id) || p.position.code === "1"
      ? "bullpen"
      : "bench"
  }))
  const order = new Map(starters.map((s) => [s.player.person.fullName, s.slot]))
  const ranked = (role: RosterPlayer["role"]) => roster.filter((p) => p.role === role)
  return {
    team: {
      code: retrosheetTeamCode(box.team.id, box.team.abbreviation ?? box.team.name, season),
      name: box.team.name,
      lineup,
      pitcher,
      roster: [
        ...ranked("lineup").sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0)),
        ...ranked("starter"),
        ...ranked("bench").sort(byName),
        ...ranked("bullpen").sort(byName)
      ]
    },
    posted
  }
}

/** Turn a game's live feed into a filled-in setup form. */
export const toMlbGame = (feed: GameFeed): MlbGame => {
  const { gameData, liveData } = feed
  const season = Number(gameData.game.season) || seasonOf(gameData.datetime.officialDate)
  const sides = ([0, 1] as const).map((side: Side) => {
    const key = side === 0 ? "away" : "home"
    return teamSetup(liveData.boxscore.teams[key], gameData.probablePitchers?.[key], season)
  })
  const away = sides[0]!
  const home = sides[1]!
  // Since 2022 everyone uses the DH; a pitcher in a posted lineup means this game doesn't.
  const pitcherBats = [away, home].some((s) => s.posted && s.team.lineup.some((e) => e.position === "P"))
  return {
    gamePk: gameData.game.pk,
    status: gameData.status.detailedState,
    lineupsPosted: [away.posted, home.posted],
    setup: {
      date: gameData.datetime.officialDate,
      gameNumber: gameNumberOf(gameData.game.doubleHeader, gameData.game.gameNumber),
      useDH: !pitcherBats,
      innings: liveData.linescore?.scheduledInnings ?? 9,
      site: retrosheetParkId(gameData.venue.id),
      teams: [away.team, home.team]
    }
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

const describeError = (what: string) => (cause: unknown) =>
  new MlbApiError({
    message: `Couldn't get ${what} from MLB: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause
  })

export class MlbApi extends Context.Service<MlbApi, {
  /** Every MLB game on a day (YYYY-MM-DD). */
  readonly schedule: (date: string) => Effect.Effect<ReadonlyArray<ScheduledGame>, MlbApiError>
  /** One game, ready to fill in the setup form. */
  readonly game: (gamePk: number) => Effect.Effect<MlbGame, MlbApiError>
}>()("mlb/MlbApi") {
  static readonly layerWithoutHttp = Layer.effect(
    MlbApi,
    Effect.gen(function*() {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(flow(HttpClientRequest.prependUrl("https://statsapi.mlb.com/api"), HttpClientRequest.acceptJson)),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({ schedule: Schedule.exponential(200), times: 2 })
      )
      return MlbApi.of({
        schedule: (date) =>
          client.get("/v1/schedule", { urlParams: { sportId: "1", date, hydrate: "probablePitcher,team" } }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ScheduleResponse)),
            Effect.map(toScheduledGames),
            Effect.mapError(describeError(`the schedule for ${date}`)),
            Effect.withSpan("MlbApi.schedule", { attributes: { date } })
          ),
        game: (gamePk) =>
          client.get(`/v1.1/game/${gamePk}/feed/live`).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(GameFeed)),
            Effect.map(toMlbGame),
            Effect.mapError(describeError(`game ${gamePk}`)),
            Effect.withSpan("MlbApi.game", { attributes: { gamePk } })
          )
      })
    })
  )

  static readonly layer = MlbApi.layerWithoutHttp.pipe(Layer.provide(FetchHttpClient.layer))
}
