"""Unit tests for the darts maths (plain functions, no harness)."""

from parallax.values import Vec2, Vec3

from game.config import Board
from game.darts import MISS, Hit, Outcome, Ring, countdown, predict_path, scatter, score_dart

# A standard board, written out: a plain test has no context to read
# config/board.json from (`test_match.py` checks the shipped one).
BOARD = Board(
    radius=0.9, inner_bull=0.055, outer_bull=0.12, treble_inner=0.54, treble_outer=0.63,
    double_inner=0.91, inner_bull_points=50, outer_bull_points=25,
    sequence=[20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5],
)
R = BOARD.radius


def test_rings_by_radius():
    assert score_dart(Vec2(0, 0), BOARD) == Hit(ring=Ring.INNER_BULL, value=50)
    assert score_dart(Vec2(0, R * 0.1), BOARD) == Hit(ring=Ring.OUTER_BULL, value=25)
    assert score_dart(Vec2(0, R * 0.58), BOARD) == Hit(ring=Ring.TREBLE, number=20, value=60)
    assert score_dart(Vec2(0, R * 0.95), BOARD) == Hit(ring=Ring.DOUBLE, number=20, value=40)
    assert score_dart(Vec2(0, R * 1.05), BOARD) == MISS


def test_wedges_by_angle():
    assert score_dart(Vec2(R * 0.8, 0), BOARD).number == 6    # 3 o'clock
    assert score_dart(Vec2(0, -R * 0.8), BOARD).number == 3   # 6 o'clock
    assert score_dart(Vec2(-R * 0.8, 0), BOARD).number == 11  # 9 o'clock


def test_countdown_and_bust_rule():
    assert countdown(40, Hit(ring=Ring.DOUBLE, number=20, value=40)) is Outcome.CHECKOUT
    assert countdown(40, Hit(ring=Ring.SINGLE, number=19, value=19)) is Outcome.SCORED
    assert countdown(40, Hit(ring=Ring.TREBLE, number=13, value=39)) is Outcome.BUST  # would leave 1
    assert countdown(40, Hit(ring=Ring.TREBLE, number=20, value=60)) is Outcome.BUST
    assert countdown(40, MISS) is Outcome.MISS


def test_scatter_is_zero_in_the_clean_band():
    assert scatter(0.5, 0.42, 0.66, 0.148) == 0
    assert scatter(0.0, 0.42, 0.66, 0.148) == 0.148
    assert scatter(1.0, 0.42, 0.66, 0.148) == 0.148


def test_predicted_path_stops_at_the_board_plane():
    path = predict_path(Vec3(0, 1.62, 0.3), Vec3(0, 0, -20), Vec3(0, -9.81, 0),
                        stop_z=-4.38, floor_y=0.12, points=40, step=0.02)
    assert path[-1].z <= -4.38
    assert path[-1].y < 1.62
