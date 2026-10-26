/**
 * Retrosheet codes for MLB Stats API ids: team codes (NYA, SFN...) and park
 * ids (NYC21...). Unknown teams fall back to MLB's abbreviation, unknown
 * parks to no site at all.
 */

const teamCodes: Readonly<Record<number, string>> = {
  108: "ANA",
  109: "ARI",
  110: "BAL",
  111: "BOS",
  112: "CHN",
  113: "CIN",
  114: "CLE",
  115: "COL",
  116: "DET",
  117: "HOU",
  118: "KCA",
  119: "LAN",
  120: "WAS",
  121: "NYN",
  133: "ATH",
  134: "PIT",
  135: "SDN",
  136: "SEA",
  137: "SFN",
  138: "SLN",
  139: "TBA",
  140: "TEX",
  141: "TOR",
  142: "MIN",
  143: "PHI",
  144: "ATL",
  145: "CHA",
  146: "MIA",
  147: "NYA",
  158: "MIL"
}

/** The Retrosheet team code for an MLB team id; the Athletics were OAK until 2025. */
export const retrosheetTeamCode = (teamId: number, abbreviation: string, season: number): string => {
  if (teamId === 133 && season < 2025) return "OAK"
  if (teamId === 146 && season < 2012) return "FLO"
  return teamCodes[teamId] ?? abbreviation.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4)
}

const parkIds: Readonly<Record<number, string>> = {
  1: "ANA01", // Angel Stadium
  2: "BAL12", // Oriole Park at Camden Yards
  3: "BOS07", // Fenway Park
  4: "CHI12", // Rate Field
  5: "CLE08", // Progressive Field
  7: "KAN06", // Kauffman Stadium
  12: "STP01", // Tropicana Field
  14: "TOR02", // Rogers Centre
  15: "PHO01", // Chase Field
  17: "CHI11", // Wrigley Field
  19: "DEN02", // Coors Field
  22: "LOS03", // Dodger Stadium
  31: "PIT08", // PNC Park
  32: "MIL06", // American Family Field
  680: "SEA03", // T-Mobile Park
  2392: "HOU03", // Daikin Park
  2394: "DET05", // Comerica Park
  2395: "SFO03", // Oracle Park
  2602: "CIN09", // Great American Ball Park
  2680: "SAN02", // Petco Park
  2681: "PHI13", // Citizens Bank Park
  2889: "STL10", // Busch Stadium
  3289: "NYC20", // Citi Field
  3309: "WAS11", // Nationals Park
  3312: "MIN04", // Target Field
  3313: "NYC21", // Yankee Stadium
  4169: "MIA02", // loanDepot park
  4705: "ATL03", // Truist Park
  5325: "ARL03" // Globe Life Field
}

/** The Retrosheet park id for an MLB venue id, or "" if we don't know it. */
export const retrosheetParkId = (venueId: number): string => parkIds[venueId] ?? ""
