"""Unit tests for the pure rules and search (plain functions, no harness)."""

from dataclasses import dataclass

from parallax.values import Cell

from game.well import EMPTY_WELL, Cells, Disc, best_column, disc_at, drop, turn, winning_run


@dataclass(frozen=True)
class Weights:
    """Satisfies `game.well.Heuristic`, like the game's config record does."""
    centre: float = 4
    open_three: float = 8
    open_two: float = 3
    threat: float = -9


def well_from(drops: str) -> Cells:
    """Columns as digits, alternating amber then teal: "3344" -> a3 t3 a4 t4."""
    cells = EMPTY_WELL
    for col in drops:
        cells, _ = drop(cells, int(col), turn(cells))
    return cells


def test_discs_stack_and_alternate():
    cells = well_from("33")
    assert disc_at(cells, Cell(3, 0)) is Disc.AMBER and disc_at(cells, Cell(3, 1)) is Disc.TEAL
    assert turn(cells) is Disc.AMBER


def test_diagonal_run_is_found_in_order():
    cells = well_from("0112232336")  # amber climbs a diagonal from (0, 0)
    cells, at = drop(cells, 3, Disc.AMBER)
    assert at == Cell(3, 3)
    assert winning_run(cells, at) == [Cell(0, 0), Cell(1, 1), Cell(2, 2), Cell(3, 3)]


def test_teal_takes_a_win_and_blocks_a_loss():
    assert best_column(well_from("061626"), Disc.TEAL, depth=4, node_budget=50_000, heuristic=Weights()) == 6
    assert best_column(well_from("06050"), Disc.TEAL, depth=4, node_budget=50_000, heuristic=Weights()) == 0
