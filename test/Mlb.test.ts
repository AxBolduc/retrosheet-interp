import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { readFileSync } from "node:fs"
import { retrosheetParkId, retrosheetTeamCode } from "../src/mlb/Codes.ts"
import { GameFeed, MlbApi, toMlbGame } from "../src/mlb/MlbApi.ts"
import { formatRecord } from "../src/retrosheet/Record.ts"
import { playerName } from "../src/retrosheet/Game.ts"
import { Session } from "../src/Session.ts"
import { currentGame, findRosterPlayer, Scorer } from "../src/tui/Scorer.ts"
import { setupRecords, validateSetup } from "../src/tui/Setup.ts"

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

const feed = Schema.decodeUnknownSync(GameFeed)(fixture("mlb-feed-849802.json"))

/** The same game before the lineups were announced: rosters and probable pitchers only. */
const beforeLineups: GameFeed = {
  ...feed,
  liveData: {
    ...feed.liveData,
    boxscore: {
      teams: {
        away: { ...feed.liveData.boxscore.teams.away, battingOrder: [], pitchers: [], players: withoutOrder(feed.liveData.boxscore.teams.away.players) },
        home: { ...feed.liveData.boxscore.teams.home, battingOrder: [], pitchers: [], players: withoutOrder(feed.liveData.boxscore.teams.home.players) }
      }
    }
  }
}

function withoutOrder<P extends { readonly battingOrder?: string }>(players: Readonly<Record<string, P>>) {
  return Object.fromEntries(Object.entries(players).map(([k, { battingOrder: _, ...p }]) => [k, p]))
}

describe("MLB codes", () => {
  it("maps MLB ids to Retrosheet team codes and parks", () => {
    assert.strictEqual(retrosheetTeamCode(147, "NYY", 2026), "NYA")
    assert.strictEqual(retrosheetTeamCode(133, "ATH", 2024), "OAK")
    assert.strictEqual(retrosheetTeamCode(133, "ATH", 2026), "ATH")
    assert.strictEqual(retrosheetTeamCode(9999, "x-y", 2026), "XY")
    assert.strictEqual(retrosheetParkId(3313), "NYC21")
    assert.strictEqual(retrosheetParkId(9999), "")
  })
})

describe("MLB game feed", () => {
  it.effect("fills in the setup from posted lineups", () =>
    Effect.gen(function*() {
      const game = toMlbGame(feed)
      const { setup } = game
      assert.deepStrictEqual(game.lineupsPosted, [true, true])
      assert.strictEqual(setup.date, "2026-10-24")
      assert.strictEqual(setup.gameNumber, 0)
      assert.isTrue(setup.useDH)
      assert.strictEqual(setup.site, "MIL06")
      const [away, home] = setup.teams
      assert.strictEqual(away.code, "TBA")
      assert.strictEqual(home.code, "MIL")
      assert.strictEqual(home.name, "Milwaukee Brewers")
      assert.deepStrictEqual(away.lineup[0], { name: "Yandy Díaz", position: "DH" })
      assert.deepStrictEqual(home.lineup.map((e) => e.position), ["LF", "1B", "DH", "C", "2B", "CF", "SS", "RF", "3B"])
      assert.strictEqual(away.pitcher, "Drew Rasmussen")
      assert.strictEqual(home.pitcher, "Logan Henderson")
      const roles = (home.roster ?? []).map((p) => p.role)
      assert.deepStrictEqual(roles.slice(0, 10), [...Array(9).fill("lineup"), "starter"])
      assert.isTrue(roles.includes("bench") && roles.includes("bullpen"))
      assert.deepStrictEqual(validateSetup(setup), [])
      const records = (yield* setupRecords(setup)).map(formatRecord)
      assert.include(records, "id,MIL202610240")
      assert.include(records, "info,site,MIL06")
      assert.include(records, `start,diazy001,"Yandy Díaz",0,1,10`)
    }))

  it("fills in teams, probable pitchers and rosters before the lineups are out", () => {
    const game = toMlbGame(beforeLineups)
    assert.deepStrictEqual(game.lineupsPosted, [false, false])
    const [away, home] = game.setup.teams
    assert.strictEqual(away.pitcher, "Drew Rasmussen")
    assert.strictEqual(home.pitcher, "Logan Henderson")
    assert.isTrue(away.lineup.every((e) => e.name === ""))
    assert.strictEqual(away.roster?.length, Object.keys(feed.liveData.boxscore.teams.away.players).length)
    assert.isFalse(away.roster?.some((p) => p.role === "lineup"))
  })

  it("notices a game without a DH", () => {
    const home = feed.liveData.boxscore.teams.home
    const dh = Object.entries(home.players).find(([, p]) => p.allPositions?.[0]?.abbreviation === "DH")!
    const pitcher = { code: "1", abbreviation: "P" }
    const noDH: GameFeed = {
      ...feed,
      liveData: {
        ...feed.liveData,
        boxscore: {
          teams: {
            ...feed.liveData.boxscore.teams,
            home: { ...home, players: { ...home.players, [dh[0]]: { ...dh[1], position: pitcher, allPositions: [pitcher] } } }
          }
        }
      }
    }
    assert.isFalse(toMlbGame(noDH).setup.useDH)
  })

  it.effect("fetches and decodes the schedule and a game", () =>
    Effect.gen(function*() {
      const api = yield* MlbApi
      const games = yield* api.schedule("2026-10-24")
      assert.strictEqual(games.length, 1)
      const [game] = games
      assert.strictEqual(game!.gamePk, 849802)
      assert.deepStrictEqual(game!.teams.map((t) => [t.code, t.probablePitcher]), [["TBA", "Drew Rasmussen"], ["MIL", "Logan Henderson"]])
      assert.strictEqual(game!.description, "World Series")
      const loaded = yield* api.game(849802)
      assert.strictEqual(loaded.setup.teams[0].lineup[1]?.name, "Jonathan Aranda")
    }).pipe(
      Effect.provide(
        MlbApi.layerWithoutHttp.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fakeFetch))
        )
      )
    ))

  it.effect("reports API failures", () =>
    Effect.gen(function*() {
      const api = yield* MlbApi
      const error = yield* Effect.flip(api.game(1))
      assert.strictEqual(error._tag, "MlbApiError")
      assert.include(error.message, "Couldn't get game 1 from MLB")
    }).pipe(
      Effect.provide(
        MlbApi.layerWithoutHttp.pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fakeFetch))
        )
      )
    ))
})

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input)
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  if (url.pathname === "/api/v1/schedule" && url.searchParams.get("date") === "2026-10-24") {
    return Promise.resolve(json(fixture("mlb-schedule-2026-10-24.json")))
  }
  if (url.pathname === "/api/v1.1/game/849802/feed/live") return Promise.resolve(json(fixture("mlb-feed-849802.json")))
  return Promise.resolve(new Response("not found", { status: 404 }))
}

describe("Rosters", () => {
  const roster = toMlbGame(feed).setup.teams[1].roster ?? []

  it("finds players by full name, last name, or a unique start", () => {
    assert.strictEqual(findRosterPlayer(roster, "yelich")?.name, "Christian Yelich")
    assert.strictEqual(findRosterPlayer(roster, "Chris")?.name, "Christian Yelich")
    assert.strictEqual(findRosterPlayer(roster, "william contreras")?.name, "William Contreras")
    assert.isUndefined(findRosterPlayer(roster, "Nobody Here"))
    assert.isUndefined(findRosterPlayer(roster, ""))
  })

  it.effect("substitutes roster players by last name", () =>
    Effect.gen(function*() {
      const scorer = yield* Scorer
      const { setup } = toMlbGame(feed)
      yield* scorer.startGame(setup)
      const bench = setup.teams[0].roster!.find((p) => p.role === "bench")!
      const last = bench.name.split(" ").slice(1).join(" ")
      const ph = yield* scorer.submit(`ph ${last}`)
      assert.isTrue(ph.ok, ph.output)
      const g = currentGame(yield* scorer.get)!
      assert.strictEqual(playerName(g, g.teams[0].lineup[1]!), bench.name)
    }).pipe(Effect.provide(Scorer.layer.pipe(Layer.provideMerge(Session.layer), Layer.provideMerge(NodeServices.layer)))))
})
