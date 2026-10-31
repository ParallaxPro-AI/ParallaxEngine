"""Scripted petal patterns: the velocities of every petal in one volley."""

from parallax.values import Vec2

from game.content import Fire, GuardianDef

STORM_SECOND_RING_SPEED = 0.86
STORM_SECOND_RING_TURN = 17.0
STORM_AIMED_SPEED = 1.15
STORM_AIMED_SHOTS = 3
STORM_AIMED_SPREAD = 28.6


def volley(kind: GuardianDef, origin: Vec2, target: Vec2, spin: float, count: int) -> list[Vec2]:
    """Petal velocities for a guardian's `count`-th volley. `spin` is the ring's
    current turn in degrees; a spiral is a ring whose spin advances every volley.
    The boss's storm alternates a full ring with a sparser ring plus an aimed fan."""
    speed = kind.petal_speed
    if kind.fire is Fire.AIMED:
        return fan(origin, target, speed, 1, 0)
    if kind.fire is Fire.FAN:
        return fan(origin, target, speed, kind.arms, kind.spread)
    if kind.fire in (Fire.RING, Fire.SPIRAL):
        return ring(speed, kind.arms, spin)
    if count % 2 == 0:
        return ring(speed, kind.arms, spin)
    return (ring(speed * STORM_SECOND_RING_SPEED, max(6, kind.arms // 2), spin + STORM_SECOND_RING_TURN)
            + fan(origin, target, speed * STORM_AIMED_SPEED, STORM_AIMED_SHOTS, STORM_AIMED_SPREAD))


def fan(origin: Vec2, target: Vec2, speed: float, shots: int, spread: float) -> list[Vec2]:
    """`shots` petals across `spread` degrees, centred on the line to the target."""
    heading = (target - origin).angle()
    if shots == 1:
        return [Vec2.from_angle(heading, speed)]
    first = heading - spread / 2
    return [Vec2.from_angle(first + spread * i / (shots - 1), speed) for i in range(shots)]


def ring(speed: float, shots: int, spin: float) -> list[Vec2]:
    """`shots` petals evenly around a circle, turned by `spin` degrees."""
    return [Vec2.from_angle(spin + 360 * i / shots, speed) for i in range(shots)]
