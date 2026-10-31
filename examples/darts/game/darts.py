"""Darts maths: scoring a dart by where it bit, the 501 countdown, the release
scatter and the flight model. No entities and no context.

Vectors come from the pure `parallax.values`. Two imports are not pure: `Hit` is
a `@record` because the match stores the last one for the HUD, and scoring reads
the `Board` config. Pure value types exist; a pure way to declare one doesn't
(see NOTES)."""

from enum import Enum

from parallax import field, record
from parallax.values import Vec2, Vec3

from game.config import Board


class Ring(Enum):
    MISS = "miss"
    SINGLE = "single"
    DOUBLE = "double"
    TREBLE = "treble"
    OUTER_BULL = "outer_bull"
    INNER_BULL = "inner_bull"


@record
class Hit:
    ring: Ring
    number: int = field(0, doc="Wedge number; 0 for the bulls and a miss.")
    value: int = field(0, doc="Points off the countdown.")


MISS = Hit(ring=Ring.MISS)


class Outcome(Enum):
    SCORED = "scored"
    CHECKOUT = "checkout"
    BUST = "bust"
    MISS = "miss"


def score_dart(offset: Vec2, board: Board) -> Hit:
    """Score a dart by its offset from the bull on the board face: the radius
    picks the ring, the angle picks the wedge."""
    reach = offset.length() / board.radius
    if reach > 1:
        return MISS
    if reach <= board.inner_bull:
        return Hit(ring=Ring.INNER_BULL, value=board.inner_bull_points)
    if reach <= board.outer_bull:
        return Hit(ring=Ring.OUTER_BULL, value=board.outer_bull_points)
    clockwise_from_top = (90 - offset.angle()) % 360
    wedges = len(board.sequence)
    number = board.sequence[int(clockwise_from_top / (360 / wedges) + 0.5) % wedges]
    if board.treble_inner <= reach <= board.treble_outer:
        return Hit(ring=Ring.TREBLE, number=number, value=number * 3)
    if reach >= board.double_inner:
        return Hit(ring=Ring.DOUBLE, number=number, value=number * 2)
    return Hit(ring=Ring.SINGLE, number=number, value=number)


def countdown(remaining: int, hit: Hit) -> Outcome:
    """Land on exactly zero to check out. Going below zero, or leaving 1 (which
    nothing can finish), busts: the dart is spent and the total stands."""
    if hit.ring is Ring.MISS:
        return Outcome.MISS
    left = remaining - hit.value
    if left == 0:
        return Outcome.CHECKOUT
    if left < 0 or left == 1:
        return Outcome.BUST
    return Outcome.SCORED


def scatter(power: float, clean_from: float, clean_to: float, most: float) -> float:
    """How far (m) a release can stray from the reticle: none inside the clean
    band, growing to `most` at an empty or a full meter."""
    if power < clean_from:
        off = (clean_from - power) / clean_from
    elif power > clean_to:
        off = (power - clean_to) / (1 - clean_to)
    else:
        off = 0.0
    return most * min(off, 1.0)


def launch_velocity(origin: Vec3, target: Vec3, power: float, base_speed: float, speed_range: float) -> Vec3:
    """Straight at the target, faster the harder the throw. Gravity does the rest."""
    return (target - origin).normalized() * (base_speed + power * speed_range)


def on_face(offset: Vec2) -> Vec3:
    """A board-face offset (x to the thrower's right, y up) as a world vector. The
    thrower looks down -z, so their right is world -x (the world is +x right of +z)."""
    return Vec3(-offset.x, offset.y, 0)


def face_offset(delta: Vec3) -> Vec2:
    """A world offset from the bull as the thrower reads it on the board face."""
    return Vec2(-delta.x, delta.y)


def draught_push(bearing: float, speed: float, accel_per_speed: float) -> Vec3:
    """Sideways acceleration (m/s²) of the hall's air on a dart in flight. Bearing 0
    pushes toward the thrower's right, 180 toward their left."""
    flat = Vec2.from_angle(bearing, speed * accel_per_speed)
    return Vec3(-flat.x, 0, flat.y)


def predict_path(
    origin: Vec3,
    velocity: Vec3,
    acceleration: Vec3,
    *,
    stop_z: float,
    floor_y: float,
    points: int,
    step: float,
) -> list[Vec3]:
    """Sample the flight the same way physics will fly it, until it reaches the
    board plane or the floor."""
    path, position = [], origin
    for _ in range(points):
        velocity += acceleration * step
        position += velocity * step
        path.append(position)
        if position.z <= stop_z or position.y <= floor_y:
            break
    return path


def to_par_text(over_par: int) -> str:
    """"E", "+3", "-2"."""
    return f"{over_par:+d}" if over_par else "E"
