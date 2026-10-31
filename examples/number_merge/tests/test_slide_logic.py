"""The slide-and-fuse rule, checked on hand-made boards (plain asserts, no harness)."""

from parallax.values import Cell

from game.slide_logic import Slide, Tiles, can_slide, slide


def board(*rows: tuple[int, ...]) -> Tiles:
    """Tiles from rows written top row first, as they look on screen (0 = empty).
    Row 0 is the top row, so the text needs no flipping."""
    return {Cell(col, row): value
            for row, line in enumerate(rows) for col, value in enumerate(line) if value}


def after(tiles: Tiles, plan: Slide) -> Tiles:
    result = {move.end: tiles[move.start] for move in plan.moves if not move.absorbed}
    result.update({merge.cell: merge.value for merge in plan.merges})
    return result


def test_equal_pairs_fuse_once_each() -> None:
    tiles = board((2, 2, 2, 2))
    assert after(tiles, slide(tiles, 4, 1, Cell.LEFT)) == board((4, 4, 0, 0))


def test_a_fused_tile_does_not_fuse_again_in_the_same_slide() -> None:
    tiles = board((2, 2, 4, 0))
    assert after(tiles, slide(tiles, 4, 1, Cell.LEFT)) == board((4, 4, 0, 0))


def test_tiles_slide_across_gaps_toward_the_wall() -> None:
    tiles = board((4, 0, 0, 4))
    plan = slide(tiles, 4, 1, Cell.RIGHT)
    assert after(tiles, plan) == board((0, 0, 0, 8))
    assert [m.value for m in plan.merges] == [8]


def test_up_slides_toward_the_top_row() -> None:
    tiles = board((0,), (2,), (2,))
    assert after(tiles, slide(tiles, 1, 3, Cell.UP)) == board((4,), (0,), (0,))


def test_a_slide_that_moves_nothing_is_not_a_change() -> None:
    assert not slide(board((2, 4, 0, 0)), 4, 1, Cell.LEFT).changed


def test_a_full_board_with_no_equal_neighbours_is_jammed() -> None:
    assert not can_slide(board((2, 4), (4, 2)), 2, 2)
    assert can_slide(board((2, 2), (4, 8)), 2, 2)
