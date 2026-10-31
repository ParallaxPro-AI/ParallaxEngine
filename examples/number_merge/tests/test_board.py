from parallax import SettingsPanel
from parallax.grid import GridCell
from parallax.test import GameHarness, playtest
from parallax.values import Cell
from project import Prefabs, Scenes

from game.actions import Controls
from game.board import board_grid, tiles_by_cell, values
from game.components import Tile
from game.events import BoardDealt, MilestoneReached, Slid
from game.resources import Outcome, Records, Score
from game.slide_logic import slide
from game.ui import Hud, PauseMenu, ResultPanel, TitleScreen

ACTIONS = {Cell.UP: Controls.up, Cell.DOWN: Controls.down,
           Cell.LEFT: Controls.left, Cell.RIGHT: Controls.right}


@playtest("a slide moves the board and drops in exactly one new tile")
async def slide_spawns_one(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=1)
    grid = board_grid(h.world)
    tiles = values(tiles_by_cell(h.world))
    plans = {step: slide(tiles, grid.cols, grid.rows, step) for step in ACTIONS}
    step = next(step for step, plan in plans.items() if plan.changed)

    await h.press(ACTIONS[step])
    await h.advance(seconds=0.5)

    assert len(h.emitted(Slid)) == 1
    assert len(tiles_by_cell(h.world)) == len(tiles) - len(plans[step].merges) + 1
    assert h.get(Score).points == sum(m.value for m in plans[step].merges)
    # Slid tiles keep the prefab's draw depth (above the wells).
    assert all(tile.transform.position.z == 3 for tile in tiles_by_cell(h.world).values())


@playtest("P pauses and closes the pause menu, and slides while paused do nothing")
async def paused_board(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=1)
    await h.press(Controls.pause)
    assert h.is_open(PauseMenu)
    for action in ACTIONS.values():
        await h.press(action)
    await h.advance(seconds=0.5)
    assert h.emitted(Slid) == []

    await h.press(Controls.pause)
    assert not h.is_open(PauseMenu)


@playtest("Menu from the result card leads to a clean title screen")
async def back_to_title(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=1)
    h.get(Score).outcome = Outcome.LOST
    await h.advance(seconds=0.3)  # the card waits for the last slide to settle
    await h.click(ResultPanel, "quit")
    await h.advance(frames=2)
    assert not h.is_open(ResultPanel)

    await h.press(Controls.pause)
    assert not h.is_open(PauseMenu)


@playtest("Play on the title screen deals a fresh board with two tiles")
async def title_to_board(h: GameHarness) -> None:
    await h.start(scene=Scenes.title, seed=2)
    assert h.is_open(TitleScreen)
    await h.click(TitleScreen, "play")
    await h.advance(frames=2)
    assert h.ctx.scenes.current_is(Scenes.board)
    assert len(tiles_by_cell(h.world)) == 2
    assert len(h.emitted(BoardDealt)) == 2  # the title's board, then the game's
    assert h.panel_state(Hud)["target"] == 2048


@playtest("the title card sits over a dealt 4x4 board: sixteen wells, two tiles")
async def title_over_dealt_board(h: GameHarness) -> None:
    await h.start(scene=Scenes.title, seed=2)
    prefabs = [e["prefab"] for e in h.observe()["entities"]]
    assert prefabs.count("well") == 16
    assert prefabs.count("tile") == 2 and "board" in prefabs and "backdrop" in prefabs


@playtest("Settings in the pause menu opens the built-in settings panel")
async def pause_settings(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=1)
    await h.press(Controls.pause)
    await h.click(PauseMenu, "settings")
    await h.advance(frames=1)
    assert h.is_open(SettingsPanel)


@playtest("a slide forging two new highs rings the milestone once, for the bigger tile")
async def one_milestone_per_slide(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    for tile in tiles_by_cell(h.world).values():
        tile.destroy()
    grid = board_grid(h.world)
    for cell, value in ((Cell(0, 0), 64), (Cell(1, 0), 64), (Cell(0, 1), 128), (Cell(1, 1), 128)):
        h.world.spawn(Prefabs.tile, at=grid.center(cell).xy(), components=[Tile(value=value), GridCell(cell=cell)])
    await h.advance(frames=1)

    await h.press(Controls.left)
    await h.advance(seconds=0.5)
    assert [e.value for e in h.emitted(MilestoneReached)] == [256]
    assert h.get(Score).highest == 256


@playtest("fusing two 1024s forges the target: the game is won, and New Game starts over")
async def forge_target(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    for tile in tiles_by_cell(h.world).values():
        tile.destroy()
    grid = board_grid(h.world)
    for cell in (Cell(0, 0), Cell(1, 0)):
        h.world.spawn(Prefabs.tile, at=grid.center(cell).xy(), components=[Tile(value=1024), GridCell(cell=cell)])
    await h.advance(frames=1)

    await h.press(Controls.left)
    await h.advance(seconds=0.5)
    assert h.get(Score).outcome is Outcome.WON
    assert h.is_open(ResultPanel)
    assert h.panel_state(ResultPanel)["title"] == "2048 Tile!"
    assert h.get(Records).best_tile == 2048

    await h.click(ResultPanel, "retry")
    await h.advance(frames=2)
    assert h.get(Score).points == 0 and h.get(Score).outcome is Outcome.PLAYING
    assert len(tiles_by_cell(h.world)) == 2
