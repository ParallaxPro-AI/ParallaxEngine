"""Unit tests for the pure rules (plain functions, no harness)."""

from parallax.values import Cell

from game.rules import ALL_CELLS, EMPTY_GRID, Cells, Mark, best_cells, is_full, place, turn, winning_line


def board(suns: list[Cell], moons: list[Cell]) -> Cells:
    cells = EMPTY_GRID
    for at in suns:
        cells = place(cells, at, Mark.SUN)
    for at in moons:
        cells = place(cells, at, Mark.MOON)
    return cells


def test_every_opening_move_draws_with_perfect_play():
    assert best_cells(EMPTY_GRID, Mark.SUN) == list(ALL_CELLS)


def test_moon_blocks_a_line():
    assert best_cells(board([Cell(0, 0), Cell(1, 0)], [Cell(1, 1)]), Mark.MOON) == [Cell(2, 0)]


def test_moon_takes_a_win_over_a_block():
    suns = [Cell(0, 0), Cell(1, 0), Cell(2, 2)]
    moons = [Cell(0, 1), Cell(1, 1)]
    assert best_cells(board(suns, moons), Mark.MOON) == [Cell(2, 1)]


def test_a_diagonal_is_a_line():
    assert winning_line(board([Cell(2, 0), Cell(1, 1), Cell(0, 2)], [])) == (Cell(2, 0), Cell(1, 1), Cell(0, 2))


def test_perfect_players_always_draw():
    cells = EMPTY_GRID
    while not winning_line(cells) and not is_full(cells):
        cells = place(cells, best_cells(cells, turn(cells))[0], turn(cells))
    assert winning_line(cells) is None
