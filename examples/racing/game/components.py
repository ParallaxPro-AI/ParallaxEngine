"""Per-entity data: the circuit, each car's race progress, and the player's nitro tank.
Also the tags, including the scene tag that marks a scene as a race track."""

from parallax import ContentRef, Vec3, component, field, tag

from game.content import CarDef

PlayerCar = tag("player_car")
ShowroomCar = tag("showroom_car")
GhostCar = tag("ghost_car")

TrackScene = tag("track")
"""Scene tag (`"tags": ["track"]` in scene.json). The race systems, the drive controls
and the pause menu exist only in scenes that carry it."""


@component("racing_line")
class RacingLine:
    """The ordered gates of a circuit, placed once per track scene. Racers pass them in
    order; the last gate is the start/finish line."""
    points: list[Vec3] = field()
    gate_radius: float = field(16, unit="m", doc="How close a car must pass to a gate's centre.")


@component("racer")
class Racer:
    """One car's race. Written by LapCounting and Standings; read by drivers and the HUD."""
    car: ContentRef[CarDef] = field()
    gates_passed: int = field(0, doc="Gates passed since the start. Lap and next gate derive from it.")
    lap_started_at: float = field(0, unit="s")
    best_lap: float = field(0, unit="s", doc="0 until a lap is completed.")
    place: int = field(1, min=1)
    finish_place: int = field(0, doc="0 while still racing.")
    finish_time: float = field(0, unit="s")
    wrong_way_for: float = field(0, unit="s")


@component("nitro")
class Nitro:
    """The player's nitro tank. The nitro part bought in the garage stacks modifiers on
    `capacity` and `gain_scale`."""
    charge: float = field(0, min=0, unit="s")
    capacity: float = field(3, min=0, unit="s", modifiable=True)
    gain_scale: float = field(1, min=0, modifiable=True)
    active: bool = field(False)
