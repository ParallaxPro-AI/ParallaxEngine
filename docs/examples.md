# Choosing an example

The [examples directory](https://github.com/ParallaxPro-AI/ParallaxEngine/tree/main/examples)
contains complete games with source and playtests. Choose one for its mechanics
and structure; you do not need every feature it includes.

| You are building | Start with |
|---|---|
| Board or tile game | `tic_tac_toe`, `four_in_a_row`, `number_merge`, `chess`, `match_three` |
| Puzzle | `crate_puzzle`, `maze_chase`, `typing_game` |
| Arcade action | `auto_runner`, `endless_runner`, `bullet_hell`, `brick_breaker`, `paddle_duel` |
| Platformer or third-person action | `platformer`, `horde_survival`, `twin_stick_roguelite`, `fighting_game` |
| First-person shooter | `fps_shooter` |
| Sports, aiming and throwing | `basketball`, `soccer`, `darts` |
| Vehicles, racing and downhill courses | `racing`, `cargo_plane`, `tank_battle` |
| Strategy and defense | `tower_defense`, `lane_defense`, `moba` |
| Co-op or management | `coop_cooking` |
| Multiplayer | `pirate_sailing`, `moba` |
| Open world, sandbox, farming or crafting | `open_world_rpg`, `voxel_survival`, `open_world_sandbox` |

The examples are finished, polished games: their models, scenes, UI and tuning are
a better starting point than an empty template when the game is close to one.
`parallax new --list` shows them all with their titles.

Read the entrypoint (`game/main.py`), the logic behind one mechanic, its prefab
and scene data, and the tests that exercise it. For a smaller starting point,
use one of the [CLI templates](getting-started.md#create-and-play).

To run an example, pass its folder to the [CLI](cli.md) wherever a project path
is expected. To make your own game from one, copy it with `parallax new`:

```sh
pnpm parallax new ../my-game --example racing --name "Snow Run"
```

This copies the whole game without its generated output and changes only the `id`
and `title` in `game/main.py`. Keep the systems, models and polish that fit your
game, replace or delete the rest, and update its playtests as you change its
mechanics.

For individual models or game pieces, use the [shared library](concepts/assets.md)
instead of copying a whole game.
