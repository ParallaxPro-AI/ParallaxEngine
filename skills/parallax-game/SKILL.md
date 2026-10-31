---
name: parallax-game
description: Create, extend, or debug games built with ParallaxEngine. Use for Parallax game authoring with Python scripts, JSON scenes and prefabs, and HTML/CSS panels; not for developing the engine itself.
---

# Author a ParallaxEngine game

The engine's value is what you don't have to write: thousands of code-built
models, terrain, foliage, sky and weather, water, particles, buildings from
ASCII floor plans, vehicles, characters with animation, UI kits and complete
example games. A game made of boxes and stacked cones wastes the engine. Use
an engine feature wherever one fits, and write code for what is unique to
this game.

## Find the project and tools

Identify the game folder and engine checkout. The checkout contains
`packages/cli/bin/parallax.mjs`, `sdk/`, and `docs/`; it may be separate from the
game and from this installed skill. Resolve the paths below against that
checkout, not the skill's installation directory.

Read `docs/cheatsheet.md` first: it covers the APIs, file formats and CLI loop
most games need, so you rarely need other docs to start. Read `docs/cli.md`
for command invocation. Use the checkout's CLI so its transpiler, SDK, and
runtime agree. If the checkout cannot be located from the workspace or
user-provided paths, ask for its path.

## Plan the game around engine features

Before writing code, read the capability catalog and quality bar in
`docs/concepts/visuals.md`, then write a short plan that maps every thing the
request mentions to what provides it:

- **Objects and props** (pins, trees, rocks, stalls, buildings, vehicles,
  characters): search the library with
  `pnpm parallax library search <words>` and add matches with
  `pnpm parallax library add <id>... <game>`. When no piece fits, author a
  `.model.json` model (materials, parts, joints) starting from the closest
  library model's file, rather than placing loose primitive shapes.
- **Buildings, rooms and venues**: `Structure` from an ASCII `.plan` floor plan
  (`parallax.procgen`), not walls placed box by box.
- **Ground, slopes and landscapes**: the terrain system, not a flat box.
- **Vegetation**: foliage and nature scatter, not primitives.
- **Sky, time of day, weather, water**: the engine's atmosphere, weather and
  water features.
- **Feel**: particles for impacts, spray, dust and splashes, matched to what
  happens and sized to it (an explosion only where something blows up; scores
  are celebrated in the UI and sound); animation clips for characters; synth or
  library audio for actions.
- **Mechanics**: an engine plugin or library piece where one exists (time
  trials, vehicles, characters, navigation and AI, combat, wind, cinematics,
  save, HUD and menus) before writing your own. The examples show which
  plugins a game of each kind lists in `Game(plugins=[...])`.

Keep the plan in your working notes and follow it.

## Choose the starting point

For an existing game, inspect its entrypoint, relevant logic, data, and tests
before editing. Preserve its structure and the user's intended behavior.

For a new game, check `docs/examples.md` first. The examples are finished,
polished games. When one is close to the request (racing for a downhill
course, an open-world game for a farm, a sports game for a ball game), start
from it with `pnpm parallax new <dir> --example <name>` and adapt it: keep
the systems, models and polish that fit, replace the rest, and update its
playtests. Otherwise choose a CLI template (`pnpm parallax new --list`) and
build up from the plan.

## Read only what the change needs

Documentation owns engine concepts; this skill owns the authoring workflow.
Use these local guides instead of inferring contracts from another engine:

| Task | Read |
|---|---|
| Most APIs, formats and commands in one place | `docs/cheatsheet.md` |
| Engine capabilities and how to make a game look good | `docs/concepts/visuals.md` |
| First game or project structure | `docs/concepts/project-layout.md` |
| State, schemas, and tunables | `docs/concepts/data.md` |
| Behaviors, systems, and events | `docs/concepts/logic.md` |
| Prefabs, scenes, and placement | `docs/concepts/world.md` |
| Models, animation, audio, and library pieces | `docs/concepts/assets.md` |
| Controls and devices | `docs/concepts/input.md` |
| Panels and player-facing text | `docs/concepts/ui.md` |
| Python syntax or imports | `docs/concepts/parallax-python.md` |
| Playtests or a failed check | `docs/concepts/testing.md`, `docs/concepts/diagnostics.md` |

Look up exact signatures in `sdk/parallax/*.pyi` (core: `__init__.pyi`) and
`sdk/project.pyi`, or their generated pages under `docs/reference/`. Discover
library pieces with `library search` rather than assuming a piece exists, and
read one example's use of a feature rather than several.

## Implement and verify

Work in the game's source files. Run the project check after meaningful edits
and resolve errors and warnings. Warnings about primitive-built scenery,
missing sky or effects, or hand-built buildings point to the engine feature
to use instead: follow them. If the API is unclear, consult its declaration
and a current example before writing a replacement abstraction.

Write or update focused playtests for the behavior being added or repaired.
For a bug, reproduce the failing behavior before the fix when practical.
Investigate failures instead of weakening assertions to obtain a passing run.

Look at the game, not just its tests: `pnpm parallax screenshot <game>`
renders the running game to PNG files and reports page errors. Look at the
images and fix what looks wrong or plain (shapes standing in for real
objects, empty sky, flat untextured ground, missing effects) before you
finish, and take another screenshot after a visual change.

Do not use missing-asset options to present an incomplete game as verified.
Report the game path, how to play it, what passed, which engine features and
library pieces it uses, and what remains unverified.
