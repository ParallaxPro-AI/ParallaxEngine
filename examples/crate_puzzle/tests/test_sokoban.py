"""The pushing rules on hand-made yards (plain asserts, no harness). Yards are drawn
top line first, and the top line is row 0."""

from parallax.values import Cell

from game.sokoban import Yard, parse, step, unstep


def yard(*rows: str) -> Yard:
    plan = parse(list(rows))
    return Yard(plan.walls, plan.pads, plan.crates, plan.bot)


def test_parse_reads_every_symbol() -> None:
    plan = parse(["#####", "#@$.#", "#+* #", "####"])
    assert plan.bot == Cell(1, 2)  # the last bot symbol read wins
    assert plan.crates == {Cell(2, 1), Cell(2, 2)}
    assert plan.pads == {Cell(3, 1), Cell(1, 2), Cell(2, 2)}
    assert Cell(4, 3) in plan.walls  # the short last line is padded with wall


def test_walking_into_a_crate_pushes_it_and_records_a_capital() -> None:
    move = step(yard("#####", "#@$ #", "#####"), Cell.RIGHT)
    assert move is not None
    assert move.crate == (Cell(2, 1), Cell(3, 1))
    assert move.letter == "R"


def test_walking_up_heads_for_row_zero() -> None:
    move = step(yard("###", "# #", "#@#", "###"), Cell.UP)
    assert move is not None
    assert move.bot == Cell(1, 1)
    assert move.letter == "u"


def test_a_crate_against_a_wall_or_another_crate_does_not_move() -> None:
    assert step(yard("####", "#@$#", "####"), Cell.RIGHT) is None
    assert step(yard("######", "#@$$ #", "######"), Cell.RIGHT) is None


def test_undoing_a_push_pulls_the_crate_back() -> None:
    back = unstep(yard("#####", "# @$#", "#####"), "R")
    assert back.bot == Cell(1, 1)
    assert back.crate == (Cell(3, 1), Cell(2, 1))


def test_solved_when_every_crate_is_on_a_pad() -> None:
    assert yard("####", "#@*#", "####").solved
    assert not yard("#####", "#@$.#", "#####").solved
