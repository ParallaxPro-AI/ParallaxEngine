"""Geometry over a racing line: where gates are, where cars start and respawn, and how
far round the lap a car has got."""

from parallax import Vec3, heading_to

from game.components import Racer, RacingLine
from game.config import RaceRules


def next_gate(line: RacingLine, racer: Racer) -> int:
    return racer.gates_passed % len(line.points)


def gate(line: RacingLine, index: int) -> Vec3:
    return line.points[index % len(line.points)]


def laps_done(line: RacingLine, racer: Racer) -> int:
    return racer.gates_passed // len(line.points)


def flat_distance(a: Vec3, b: Vec3) -> float:
    return (b - a).flat().length()


def pose_before_gate(line: RacingLine, index: int, back: float) -> tuple[Vec3, float]:
    """A point `back` metres before gate `index` along the line, and the yaw that
    faces down it."""
    here, before = gate(line, index), gate(line, index - 1)
    direction = (here - before).flat().normalized()
    return here - direction * back, heading_to(before, here)


def grid_pose(line: RacingLine, slot: int, rules: RaceRules) -> tuple[Vec3, float]:
    """Grid slot `slot` (0 = pole): two lanes, rows walked back from the finish line."""
    start, yaw = pose_before_gate(line, 0, rules.grid_first_row + (slot // 2) * rules.grid_row_gap)
    across = (gate(line, 0) - gate(line, -1)).flat().normalized().cross(Vec3.UP)
    lane = -rules.grid_lane_offset if slot % 2 == 0 else rules.grid_lane_offset
    return start + across * lane, yaw


def race_order(line: RacingLine, car_position: Vec3, racer: Racer) -> tuple[int, float, float]:
    """Sort key: finishers by finishing place, then the most gates, then the closest to
    the next one."""
    if racer.finish_place:
        return (0, racer.finish_place, 0)
    return (1, -racer.gates_passed, flat_distance(car_position, gate(line, racer.gates_passed)))


def line_offset(line: RacingLine, car_position: Vec3, racer: Racer) -> float:
    """Metres from the car to the racing line: the nearest of the three segments around
    its next gate (gates are tens of metres apart, so the distance to the gate points
    alone would read "off the road" mid-straight)."""
    index = next_gate(line, racer)
    best = 1e9
    for k in (index - 2, index - 1, index):
        a, b = gate(line, k).flat(), gate(line, k + 1).flat()
        span = b - a
        length2 = span.dot(span)
        u = 0.0 if length2 < 1e-6 else max(0.0, min(1.0, (car_position.flat() - a).dot(span) / length2))
        best = min(best, (car_position.flat() - (a + span * u)).length())
    return best
