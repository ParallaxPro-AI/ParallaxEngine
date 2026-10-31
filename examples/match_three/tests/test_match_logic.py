"""The pure rules, checked on hand-made boards (plain asserts, no harness). Boards are
drawn top row first, as they look on screen; the top row is row 0."""

from parallax.values import Cell

from game.match_logic import Board, Special, deal, find_runs, find_swap, has_match, plan_wave

KINDS = {"R": "ruby", "G": "emerald", "B": "sapphire", "Y": "topaz"}


def board(*rows: str) -> Board:
    kinds = {Cell(col, row): KINDS[ch] for row, line in enumerate(rows) for col, ch in enumerate(line)}
    return Board(len(rows[0]), len(rows), kinds)


def test_a_run_of_three_clears_it() -> None:
    wave = plan_wave(board("RRRG", "GBYB", "BYGY"), {}, None, bomb_radius=1)
    assert wave.clears == {Cell(0, 0), Cell(1, 0), Cell(2, 0)}
    assert wave.forged == {}


def test_a_run_of_four_forges_a_line_gem_on_the_swapped_cell() -> None:
    wave = plan_wave(board("RRRRG", "GBYBY", "BYGYB"), {}, focus=Cell(1, 0), bomb_radius=1)
    assert wave.forged == {Cell(1, 0): Special.LINE}
    assert Cell(1, 0) not in wave.clears


def test_crossing_runs_forge_a_bomb_where_they_meet() -> None:
    wave = plan_wave(board("RGB", "RGB", "RRR"), {}, None, bomb_radius=1)
    assert wave.forged == {Cell(0, 2): Special.BOMB}


def test_a_line_gem_caught_in_a_match_clears_its_row_and_column() -> None:
    wave = plan_wave(board("RRRG", "GBYB", "BYGY", "YGBG"), {Cell(1, 0): Special.LINE}, None, bomb_radius=1)
    assert {Cell(3, 0), Cell(1, 1), Cell(1, 2), Cell(1, 3)} <= wave.clears
    assert wave.detonated


def test_a_dealt_board_has_no_match_and_a_legal_swap() -> None:
    dealt = deal(8, 8, list(KINDS.values()))
    assert not has_match(dealt)
    assert find_swap(dealt) is not None
    assert find_runs(dealt) == []
