from parallax.test import GameHarness, playtest
from parallax.values import Cell
from project import Content, Scenes

from game.actions import Controls
from game.board import board_grid, board_of, gems_by_cell
from game.components import Crust, Gem
from game.events import BoardSettled, StageCleared, SwapRejected
from game.match_logic import Board, find_swap, has_match
from game.resources import Outcome, Records, Run
from game.ui import Hud, PauseMenu, RelicDraft, ResultPanel, TitleScreen


def board_now(h: GameHarness) -> Board:
    return board_of(board_grid(h.world), gems_by_cell(h.world))


def legal_swap(h: GameHarness) -> tuple[Cell, Cell]:
    swap = find_swap(board_now(h))
    assert swap is not None
    return swap


def dud_swap(h: GameHarness) -> tuple[Cell, Cell]:
    board = board_now(h)
    for cell in board.cells():
        other = cell + Cell.RIGHT
        if board.contains(other) and not has_match(board.swapped(cell, other)):
            return cell, other
    raise AssertionError("every horizontal swap matches")


async def tap_pair(h: GameHarness, a: Cell, b: Cell) -> None:
    """Tap two cells, then wait until the swap has fully played out."""
    grid = board_grid(h.world)
    settled = len(h.emitted(BoardSettled))
    await h.tap_world(grid.center(a))
    await h.tap_world(grid.center(b))
    await h.advance_until(lambda: len(h.emitted(BoardSettled)) > settled)


@playtest("a matching swap spends one move and scores")
async def matching_swap(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    await tap_pair(h, *legal_swap(h))
    run = h.get(Run)
    assert run.moves_left == Content.stage.seam.data.moves - 1
    assert run.stage_score > 0


@playtest("a swap that makes no match slides back and keeps the move")
async def rejected_swap(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    a, b = dud_swap(h)
    before = gems_by_cell(h.world)
    await tap_pair(h, a, b)
    assert len(h.emitted(SwapRejected)) == 1
    assert gems_by_cell(h.world) == before
    assert h.get(Run).moves_left == Content.stage.seam.data.moves


@playtest("running out of moves ends the run, and New Run starts over")
async def out_of_moves(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    h.get(Run).moves_left = 1
    await tap_pair(h, *legal_swap(h))
    assert h.get(Run).outcome is Outcome.LOST
    assert h.is_open(ResultPanel)

    await h.click(ResultPanel, "retry")
    await h.advance(frames=2)
    assert h.get(Run).outcome is Outcome.PLAYING
    assert not h.is_open(ResultPanel)
    assert h.get(Run).moves_left == Content.stage.seam.data.moves


@playtest("the title screen shows a dealt board, with no pause menu and no leftover result card")
async def title_is_clean(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    h.get(Run).moves_left = 1
    await tap_pair(h, *legal_swap(h))
    await h.click(ResultPanel, "quit")
    await h.advance(frames=2)
    assert not h.is_open(ResultPanel)
    assert h.is_open(TitleScreen)
    assert h.world.query(Gem).count() == 64, "the board is dealt behind the title card"

    await h.press(Controls.pause)
    assert not h.is_open(PauseMenu)


@playtest("clearing a stage opens the relic draft, and the pick carries into the next stage")
async def stage_clear_and_draft(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    h.get(Run).stage_score = Content.stage.seam.data.target
    await tap_pair(h, *legal_swap(h))
    assert [cleared.stage for cleared in h.emitted(StageCleared)] == [1]
    offer = h.get(Run).offer
    assert h.is_open(RelicDraft) and len(offer) == 3

    assert not h.is_open(Hud), "the HUD hides under the draft"

    picked = offer[0]
    await h.click(RelicDraft, "pick", relic=picked.id)
    await h.advance(frames=2)
    run = h.get(Run)
    assert not h.is_open(RelicDraft)
    assert (run.stage_index, run.relics, run.stage_score) == (1, [picked], 0)
    assert h.world.query(Crust).count() == 4, "the second stage has four crusted cells"
    assert h.is_open(Hud)


@playtest("clearing the last stage wins the descent and records the deepest stage")
async def final_stage_wins(h: GameHarness) -> None:
    await h.start(scene=Scenes.board, seed=3)
    h.get(Run).stage_index = 5
    h.ctx.scenes.reload()
    await h.advance(frames=2)
    for crust, _ in h.world.query(Crust):
        crust.destroy()
    h.get(Run).stage_score = Content.stage.core.data.target
    await tap_pair(h, *legal_swap(h))
    assert h.get(Run).outcome is Outcome.WON
    assert h.is_open(ResultPanel)
    assert h.get(Records).best_stage == 6
