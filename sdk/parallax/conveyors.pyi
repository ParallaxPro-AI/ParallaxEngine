"""Conveyors plugin: items riding conveyor lanes, simulated by the engine each fixed step
and drawn as instanced copies of each kind's model. Thousands of moving items cost no
entities and no game code per frame; the game builds lanes, links them, and puts items
on and takes them off where its machines meet the belts.

    lane = ctx.conveyors.lane([vec3(0, 0.3, 0), vec3(4, 0.3, 0)], speed=2, spacing=0.25)
    ctx.conveyors.look("ore", Assets.models.ore_chunk, scale=0.2)
    ctx.conveyors.push(lane, "ore")              # at the start, if there's room
    ctx.conveyors.connect(lane, next_lane, at=0) # the end feeds the next lane
    kind = ctx.conveyors.pop(other)              # the item waiting at a lane's end

A lane is a polyline its items ride from the first point to the last at `speed` meters per
second, at least `spacing` meters apart. An item that reaches the end waits there unless
the lane feeds another, and items queue behind it, so a blocked belt backs up. Item kinds
are strings; a kind with no `look` rides unseen. Lanes are cleared when a scene loads and
are not part of save slots: store `items()` and `positions()` in a resource to keep them.
"""

from parallax import ModelRef, Vec3

class ConveyorsApi:
    def look(self, kind: str, model: ModelRef | str, *, scale: float = 1, lift: float = 0) -> None:
        """How items of `kind` look on lanes: `model` at `scale`, `lift` meters above the lane,
        turned to face along it."""
    def lane(self, points: list[Vec3], *, speed: float = 1, spacing: float = 0.25, visible: bool = True) -> int:
        """A new lane through `points` (world meters, at least 2); returns its id. Invisible
        lanes (tunnels, insides of machines) carry items without drawing them."""
    def remove(self, lane: int) -> list[str]:
        """Remove a lane; returns the kinds of the items that were on it. Lanes that fed it
        now stop at their ends."""
    def exists(self, lane: int) -> bool: ...
    def clear(self) -> None:
        """Remove every lane."""
    def connect(self, lane: int, to: int | None, *, at: float = 0) -> None:
        """Feed the end of `lane` into `to`, `at` meters along it (a side-load joins
        mid-lane); None stops the lane at its end again."""
    def set_speed(self, lane: int, speed: float) -> None:
        """Meters per second; 0 stops the lane (a belt without power)."""
    def set_visible(self, lane: int, visible: bool) -> None: ...
    def length(self, lane: int) -> float:
        """Meters from the first point to the last."""
    def room(self, lane: int, *, at: float = 0) -> bool:
        """Whether an item fits `at` meters along the lane now."""
    def push(self, lane: int, kind: str, *, at: float = 0) -> bool:
        """Put an item on the lane `at` meters along it; False (and nothing changes) when
        it doesn't fit."""
    def front(self, lane: int) -> str | None:
        """The kind of the item waiting at the lane's end, or None."""
    def pop(self, lane: int) -> str | None:
        """Take the item waiting at the lane's end; None when none has arrived."""
    def take(self, lane: int, *, near: float | None = None, reach: float = 0.5, kinds: list[str] | None = None) -> str | None:
        """Take the item nearest `near` meters along the lane (default: its end) within
        `reach`, of one of `kinds` when given; None when there's none."""
    def items(self, lane: int) -> list[str]:
        """The lane's item kinds, front (nearest the end) first."""
    def positions(self, lane: int) -> list[float]:
        """Each item's distance along the lane, matching `items()`."""
    def count(self, lane: int | None = None) -> int:
        """Items on one lane, or on all of them."""
    def point(self, lane: int, at: float) -> Vec3:
        """The world point `at` meters along the lane."""
    @property
    def lanes(self) -> int:
        """How many lanes there are."""
