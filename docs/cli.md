# Command line

The `parallax` CLI runs directly from the engine checkout after
[installation](getting-started.md#install). It needs no separate build step.

From the checkout, prefix commands with `pnpm parallax`. From another directory,
use `pnpm --dir /path/to/ParallaxEngine parallax` and pass an absolute game path.
You can also run `node /path/to/ParallaxEngine/packages/cli/bin/parallax.mjs`.

## Commands

The paths below name game folders, containing `game/main.py`.

| Command | Purpose |
|---|---|
| `new <dir>` | Create a project in an empty or missing directory |
| `check <project>` | Transpile and validate a project; see [Diagnostics](concepts/diagnostics.md) |
| `test <project>` | Run [playtests](concepts/testing.md) |
| `screenshot <project>` | Run the game in headless Chrome and save PNGs of it playing |
| `edit <project>` | Open the browser editor; Play runs the game |
| `build <project>` | Transpile, validate, and check module links |
| `library list` | List available shared-library pieces |
| `library search <words>...` | Find library pieces by meaning, best match first; see [Searching the library](#searching-the-library) |
| `library index` | Build or refresh the search index ahead of time |
| `library add <piece>... <project>` | Copy pieces and their dependencies into a game |
| `library test [<piece>...]` | Run selected library demos, or all demos if none are named |
| `serve <project>` | Run an authoritative multiplayer match server |
| `serve-relay` | Run a signalling relay for browser-hosted multiplayer |

`check`, `build`, `edit`, `serve`, and `screenshot` default to the current directory when the
project path is omitted. There is no export or publish command yet.

## Options

| Applies to | Option | Meaning |
|---|---|---|
| `new` | `--template NAME` | Choose a starter; `blank-2d` is the default |
| `new` | `--name TITLE` | Set the game's title |
| `new` | `--example NAME` | Start from a copy of an [example game](examples.md) instead of a template |
| `new` | `--list` | List templates and examples instead of creating a project |
| `check`, `build`, `test`, `screenshot`, `library list/search/add` | `--json` | Print a machine-readable report |
| `check`, `build`, `edit` | `--no-asset-files` | Allow missing asset files; see [Assets](concepts/assets.md) |
| `check`, `build`, `edit`, `test` | `--out DIR` | Choose the generated-output directory |
| `check` | `--no-write` | Discard generated output; cannot be combined with `--out` |
| `check` | `--no-compile` | Skip Python-to-JavaScript transpilation; still extract and validate Python declarations |
| `build` | `--bundle` | Also pack served files into content-addressed bundles |
| `edit` | `--no-open` | Start the editor server without opening a browser |
| `edit`, `serve`, `serve-relay` | `--host H`, `--port N` | Choose the listening address and port |
| `test`, `library test` | `--filter TEXT` | Run tests whose id or title contains the text |
| `test` | `--timeout SECONDS` | Set the wall-time limit per test; default 60 seconds |
| `test` | `--observe` | Include final-frame metadata in the JSON report |
| `screenshot` | `--out FILE.png` | Where the shot goes; default `<project>/build/screenshot.png`. Several shots are numbered `FILE-1.png`, `FILE-2.png`, … |
| `screenshot` | `--seconds N` | Seconds of play before the first shot; default 2 |
| `screenshot` | `--shots N`, `--every S` | Take N shots, S seconds of play apart; defaults 1 and 1 |
| `screenshot` | `--width W`, `--height H` | The page size in pixels; default 1280×720 |
| `screenshot` | `--keys STEPS` | Input to play, one step after another from the start; see below |
| `screenshot` | `--seed N` | Set the simulation seed, for a repeatable run |
| `screenshot` | `--timeout S` | How long the game may take to start; default 90 seconds |
| `screenshot` | `--gl auto\|gpu\|software` | Draw with the GPU or SwiftShader (software WebGL); `auto` uses SwiftShader on Linux only |
| `library search` | `--category NAME`, `--limit N` | Search one category; show up to N matches (default 10) |
| `library search` | `--keyword` | Match words only, without the embedding model |
| `library add` | `--dry-run` | Preview files and setup steps without writing |
| `library test` | `--keep` | Keep the temporary demo projects |
| `library ...`, `edit` | `--library DIR` | Add another library root; repeat it for more. See [More library roots](#more-library-roots) |
| `serve` | `--seed N` | Set the simulation seed |
| `serve` | `--drain-seconds N` | Limit graceful shutdown; default 300 seconds |
| `serve` | `--ticket-secret-env NAME`, `--match ID` | Require signed join tickets for a match; supply both |

See [Assets](concepts/assets.md) for library setup and the
[networking reference](reference/parallax.net.md) for multiplayer configuration.
The match server and relay bind to `127.0.0.1` by default, on ports 5190 and 5191
respectively. `serve` exposes `/healthz` and `/status`; SIGTERM drains the match,
while SIGINT stops it immediately.

## Screenshots

`screenshot` lets you look at the game without opening a browser yourself:

```sh
pnpm parallax screenshot examples/racing --out /tmp/racing.png
pnpm parallax screenshot my_game --shots 3 --every 1.5 --keys "click@640x400,wait:1,KeyW:4"
```

It builds the project into a temporary folder (the project's own files are not
touched), serves the game page on a free localhost port, and opens it in headless
Chrome. The game counts as loaded once it has started and stepped its first frame;
the first shot also waits for the game's downloads to finish. `--seconds`, `--every`
and `--keys` count seconds of play on the game's clock, so a slow software renderer
still shows the same moment of the game, only later.

`--keys` is a comma-separated list of steps run in order: `KeyW:2` holds a key for
2 seconds, `Space` taps it (0.1 seconds), `ShiftLeft+KeyW:1` holds several,
`wait:1` waits, and `click` or `click@XxY` (for example `click@640x400`) clicks the middle of
the page or that pixel. Keys are `KeyboardEvent.code` names; `w`, `1`, `space`, `up`,
`shift` and `esc` work too. Keys keep running between shots.

The command prints each PNG's path, the page's console errors and warnings, and any
error the game showed (with its Python traceback). It exits with code 1 when the
game fails to build, start or keep running; the shot then shows the error screen.
It needs Google Chrome or Chromium: set `PARALLAX_CHROME` (or `CHROME_PATH`) to its
executable if it is not in the usual place. Chrome and the server stop when the
command ends.

## Searching the library

`library search` ranks pieces by meaning, so `person` finds `civilian` and `evergreen`
finds `tree_pine` although neither word is in their names. Each piece's id, summary and
what its model implies (a humanoid skeleton is a person; stand or seat sockets are
rideable; its parts, materials and options) is embedded by a small local model,
`Xenova/all-MiniLM-L6-v2`, and kept in `shared_library/_index/`. Words of the query that
appear in a piece's id or text move it up, so an exact name still comes first.

The model downloads once (about 23 MB, to `.cache/` in the checkout), so the first search
needs the network. The first search also builds the index if it is missing, which takes
about half a minute; later searches reuse it. When pieces change, the next search embeds
only those again. Without the model, or with `--keyword`, search matches words only.

### Searching offline or from a read-only checkout

Set `PARALLAX_CACHE_DIR` to a writable folder to move what search writes. The model then
downloads to `$PARALLAX_CACHE_DIR/transformers/`, and the index is saved to
`$PARALLAX_CACHE_DIR/library_index/`. Search still reads the checkout's
`.cache/transformers/` and `shared_library/_index/` when the cache folder lacks them.
So a read-only checkout works with no network if `pnpm parallax library index`
already ran in it, which downloads the model and writes the index:

- A model found on disk loads with downloads turned off, so it never reaches the network.
  `PARALLAX_OFFLINE=1` turns downloads off even when no model is found; search then
  matches words only.
- If search can't save an index it had to refresh, for example because the folder is
  read-only, it uses that index from memory and says so. Set `PARALLAX_CACHE_DIR` to
  keep the refreshed index for later searches.

### More library roots

`--library DIR` (repeatable) and `PARALLAX_LIBRARY_PATH` add library roots after
`shared_library/`. Separate the folders in `PARALLAX_LIBRARY_PATH` with `:`, or `;`
on Windows. Each root has the same layout, `<category>/<piece>/piece.json`.
`library list`, `search`, `index`, `add` and `test` read every root, and so does the
asset library in `edit`. A piece may require pieces from any root.

Piece ids are shared by all roots. When two roots have the same id, the earlier one
wins, in this order: `shared_library/`, then the `--library` folders, then
`PARALLAX_LIBRARY_PATH`. The later piece is skipped with a PP9590 warning. Extra roots
can add pieces but cannot replace one. A root that does not exist is an error. The
search index covers the pieces of every root.

## Output and exit codes

`check`, `build`, and `edit` normally write to the project's `build/` directory;
`screenshot` writes only its PNG there unless `--out` is given.
`test` uses temporary output unless `--out` is given.

Exit code 0 means success, 1 means project or test errors (or a creation conflict),
and 2 means invalid usage. `check`, `build`, and `test` allow warnings;
`library test` requires a warning-free check of each demo. Running
`pnpm parallax` without a command prints usage and exits with code 2.
