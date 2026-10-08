# retrosheet-interp

An interpreter and interactive REPL for scoring baseball games in the
[Retrosheet event file](https://www.retrosheet.org/eventfile.htm) notation.

Type records line by line, just like an event file, and ask about the game as
you go: lineups, defense, runners, outs, the count, the line score, and the box
score. Every line is checked as you enter it: the right batter, the right half
inning, runners on the bases they advance from, no fourth out, and so on.
Invalid lines are rejected with an explanation and leave the game unchanged.

Built with TypeScript and [Effect](https://effect.website) v4.

## Usage

```sh
npm install
npm start                                   # empty session
npm start -- examples/NYA202303300.EVA      # load a game, then keep scoring
npm start -- examples/NYA202303300.EVA -r   # print line score and box score, then exit
```

`npm run build` compiles to `dist/`; the binary is `dist/src/main.js` (`retro`).
Commands can also be piped in on stdin.

```
retro> id,BOS202404010
New game BOS202404010.
BOS202404010> info,visteam,NYA
BOS202404010> start,volpa001,"Anthony Volpe",0,1,6
...
T1 0o> play,1,0,volpa001,32,BBCFBX,S8/G6M
  1 T1  0o ---  Anthony Volpe   S8/G6M   Single to CF [ground ball to SS]. Anthony Volpe to 1st
Top of the 1st, 0 out, 1B | NYA 0  BOS 0 | up: Aaron Judge
T1 0o> SB2                                  # shorthand: event for the current batter
T1 0o> HR/F7 BX                             # ...optionally followed by the pitches
T1 0o> lineup home
T1 0o> state
```

### Input

- **Retrosheet records**: `id`, `version`, `info`, `start`, `sub`, `play`,
  `com`, `data`, `badj`, `padj`, `ladj`, `radj`, `presadj`.
- **Shorthand events**: a line that starts with an uppercase letter or digit is
  an event for the current batter, e.g. `S8/G.1-2`, `K CBFS`, `64(1)3/GDP`.
  The inning, team, and batter are filled in, and the count is worked out from
  the pitches. `records` and `save` write out the full `play` records.
- **Commands**:

| Command | |
|---|---|
| `state` | inning, outs, base runners, batter, on deck, pitcher, count |
| `lineup [away\|home]` | batting orders with positions, current batter, and stats |
| `defense [away\|home]` | the player at each position |
| `score` | line score with R/H/E/LOB |
| `box [away\|home]` | batting and pitching box score |
| `plays [n\|all]` | play-by-play log |
| `roster`, `info` | everyone who has appeared; info records, comments |
| `explain <event>` | describe an event without scoring it |
| `undo [n]` | undo entries (a loaded file counts as one) |
| `load <file>`, `save <file>`, `records` | read and write event files |
| `games`, `game <n>` | switch between games in a multi-game file |
| `help`, `help notation` | command help, event-notation cheat sheet |

## How it works

| Module | Role |
|---|---|
| `src/retrosheet/Record.ts` | parses event-file lines into tagged `RetroRecord`s, and formats them back |
| `src/retrosheet/Event.ts` | parses the event field (`basic/modifiers.advances`) into a typed AST |
| `src/retrosheet/Engine.ts` | applies records to an immutable `GameState`: runner movement, outs, runs, half innings, game end, substitutions, stats |
| `src/Session.ts` | `Session` service: multiple games, undo history, loading and exporting |
| `src/repl/*` | command handling, rendering, and a readline-based `LineReader` service |

Runner movement follows Retrosheet's conventions. Explicit advances override
implied ones. Unmentioned runners stay put unless they're forced or a home run
clears the bases. An `X` advance is cancelled only when every fielding sequence
on it includes an error, so `1X3(5E3)` is safe while `BX3(25)(E5/TH)` is out.

## Validation

`scripts/validate-season.ts` replays a whole season of Retrosheet event files
and compares each game with Retrosheet's game logs:

```sh
npm run validate -- path/to/2023eve path/to/gl2023.txt [--verbose]
```

| Season | Games | Final scores | Team H/HR/BB/K/SB/E/LOB | Team RBI |
|---|---|---|---|---|
| 2023 | 2430 | all match | all match | all match |
| 2004 | 2428 | all match | all match | 10 team-games differ |
| 1985 | 2103 | all match | all match | 3 team-games differ |
| 1962 | 1617 | all match | all match | 9 team-games differ |

The leftover RBI differences in older seasons come from scorers' judgment
calls (runs scoring on errors) that older data doesn't record.

## Tests

```sh
npm test
npm run typecheck
```

## Data notice

The example game in `examples/` comes from Retrosheet:

> The information used here was obtained free of charge from and is copyrighted
> by Retrosheet. Interested parties may contact Retrosheet at
> [www.retrosheet.org](https://www.retrosheet.org).
