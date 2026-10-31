from parallax import vec2
from parallax.grid import GridCell, GridMover
from parallax.test import playtest
from project import Scenes

from game.actions import Controls
from game.components import Gobbler, Stalker
from game.events import PipEaten, StalkerEaten
from game.resources import Mode
from game.progress import stalker_mode
from game.progress import getting_ready
from game.resources import Best, Board, Pace, Run
from game.ui import Hud, PauseMenu, ResultPanel, TitleScreen

DOWN = vec2(0, -1)


@playtest("nothing moves during the READY freeze, but the press is remembered")
async def test_ready_freeze(game):
    await game.start(scene=Scenes.maze, seed=1)
    _, spot = game.world.query(GridCell, tagged=Gobbler).single()
    start = spot.cell
    await game.move(Controls.move, DOWN, seconds=1.0)
    assert getting_ready(game.ctx)
    assert game.panel_state(Hud)["ready"]
    assert spot.cell == start
    await game.advance(seconds=1.0)
    assert spot.cell != start


@playtest("running down the corridor eats pips")
async def test_eat_pips(game):
    await game.start(scene=Scenes.maze, seed=2)
    await game.advance(seconds=1.6)
    await game.move(Controls.move, DOWN, seconds=0.5)
    assert game.get(Run).score >= 10
    assert game.get(Board).pips_left < 188


@playtest("eating the last pip descends a level")
async def test_level_clear(game):
    await game.start(scene=Scenes.maze, seed=3)
    await game.advance(seconds=1.6)
    game.get(Board).pips_left = 1
    await game.move(Controls.move, DOWN, seconds=0.5)
    assert game.get(Run).level_index == 1
    assert game.get(Board).pips_left == 188


@playtest("standing still gets you caught, three catches end the run, and retry keeps the eased pace")
async def test_caught_and_retry(game):
    await game.start(scene=Scenes.maze, seed=4)
    await game.advance_until(lambda: game.get(Run).lives_lost == 1, timeout=60)
    await game.advance_until(lambda: game.is_open(ResultPanel), timeout=240)
    assert not game.get(Run).won
    assert game.panel_state(ResultPanel)["lost"]
    assert not game.is_open(Hud), "the HUD gives way to the result card"
    assert game.get(Pace).level < 0.5

    await game.click(ResultPanel, "retry")
    await game.advance(frames=2)
    assert not game.is_open(ResultPanel)
    assert game.get(Run).lives_lost == 0
    assert game.get(Pace).level < 0.5, "the pace is kept for the session"


@playtest("the pause key toggles the pause menu")
async def test_pause(game):
    await game.start(scene=Scenes.maze, seed=5)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("clearing the last level wins the run and keeps the deepest level")
async def test_final_level_wins(game):
    await game.start(scene=Scenes.maze, seed=6)
    game.get(Run).level_index = 3
    await game.advance(seconds=1.6)
    game.get(Board).pips_left = 1
    await game.move(Controls.move, DOWN, seconds=0.5)
    assert game.get(Run).won
    assert game.is_open(ResultPanel)
    assert game.get(Best).level == 4
    assert game.panel_state(ResultPanel)["title"] == "Warren cleared"


@playtest("a flare frightens every Stalker; touching one eats it for 200, the next for 400")
async def test_flare_and_eat(game):
    await game.start(scene=Scenes.maze, seed=7)
    await game.advance(seconds=1.6)
    gobbler = game.world.query(tagged=Gobbler).single()
    game.ctx.emit(PipEaten(flare=True, at=gobbler.transform.position))
    await game.advance(frames=1)
    stalkers = [entity for entity, _ in game.world.query(Stalker)]
    assert all(stalker_mode(game.ctx, s.get(Stalker)) is Mode.FRIGHTENED for s in stalkers)
    assert game.panel_state(Hud)["frightened"]

    score = game.get(Run).score
    for stalker in stalkers[:2]:  # set both down on the Gobbler's cell
        stalker.get(GridMover).stop()
        stalker.get(GridCell).cell = gobbler.get(GridCell).cell
        stalker.transform.position = gobbler.transform.position
    await game.advance_until(lambda: len(game.emitted(StalkerEaten)) == 2, timeout=2)
    assert [eaten.chain for eaten in game.emitted(StalkerEaten)] == [1, 2]
    assert game.get(Run).score - score == 200 + 400
    assert sum(stalker_mode(game.ctx, s.get(Stalker)) is Mode.EATEN for s in stalkers) == 2


@playtest("the title card sits over the maze, frozen at READY, and Play starts the run")
async def test_title_over_maze(game):
    await game.start(scene=Scenes.title, seed=8)
    assert game.is_open(TitleScreen)
    assert not game.is_open(Hud)
    assert game.world.query(tagged=Gobbler).count() == 1
    assert game.world.query(Stalker).count() == 4
    assert game.get(Board).pips_left == 188
    await game.advance(seconds=3)
    assert getting_ready(game.ctx), "nothing moves behind the title"

    await game.click(TitleScreen, "start")
    await game.advance(frames=2)
    assert not game.is_open(TitleScreen)
    assert game.is_open(Hud)
