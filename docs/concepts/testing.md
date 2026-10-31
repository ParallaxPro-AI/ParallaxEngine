# Testing

Playtests drive the game through actions, panel commands, and simulation frames.
They run headless with a fixed 1/60-second timestep and a seeded random source,
so a test can reproduce the same sequence of events.

## Write a playtest

Put tests in `tests/test_*.py`. The runner collects async functions decorated with
`@playtest` and plain `test_*` functions for testing pure game rules.

This test works with the `blank-2d` template:

```python
from parallax import vec2
from parallax.test import GameHarness, playtest
from project import Placed, Scenes

from game.actions import Controls


@playtest("the player moves right while the stick is pushed right")
async def test_player_moves(h: GameHarness):
    await h.start(scene=Scenes.main, seed=1)
    player = h.world.placed(Placed.player)
    start_x = player.transform.position.x
    await h.move(Controls.move, vec2(1, 0), seconds=0.5)
    assert player.transform.position.x > start_x + 1
```

Each playtest gets a fresh harness. Call `start()` once and await commands that
advance the game. Read or set state between commands through `h.world`, `h.ctx`,
and `h.get(ResourceType)`.

Test observable behavior: input moves the player, a hit changes health, a result
opens the expected panel. Set up the relevant state directly when reaching it
through normal play would make the test slow. Use `until(EventType)` or
`advance_until(condition)` when waiting for an outcome; use `advance(frames=...)`
when a specific number of frames is part of the behavior.

## Run and inspect

From the engine checkout, with a game at `../my-game`:

```sh
pnpm parallax test ../my-game
pnpm parallax test ../my-game --filter test_player_moves --json
```

`FAIL` means an assertion or wait failed; `ERROR` means an exception occurred.
Read the traceback before changing the game or the test. The
[test harness reference](../reference/parallax.test.md) lists commands and their
input semantics; the [CLI reference](../cli.md) covers runner options.

## What headless tests establish

Playtests check simulation behavior and panel state without requiring asset
files. `--observe --json` adds camera, entity, and panel metadata for each
playtest's final frame. This helps inspect placement and visibility, but does
not verify rendered graphics, CSS layout, downloaded assets, or audible output.
Use the browser editor's Play mode to check those parts of the game.
