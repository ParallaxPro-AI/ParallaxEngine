"""Wind plugin: one wind field for the scene (`"wind": {...}` in scene.json), shared by
everything that moves with the air: foliage and grass sway, streaks and blown leaves, and
gameplay (sails, drift, projectiles) through `ctx.wind`.

    "wind": {"direction": 90, "speed": 4, "gusts": 0.4, "scale": 40, "period": 6,
             "streaks": true, "debris": 24}

`direction` is the bearing the wind blows toward (degrees clockwise from +z; 90 is +x) or
an [x, z] vector. Without the block the air is calm. The field is a deterministic
function of position and game time — the same on every machine at the same moment.
"""

from parallax import Vec3

class WindApi:
    def at(self, point: Vec3) -> Vec3:
        """Wind velocity (m/s, horizontal) at `point` now, gusts included."""
    @property
    def direction(self) -> Vec3:
        """Unit direction the wind blows toward."""
    @property
    def speed(self) -> float:
        """Mean speed, m/s."""
    @property
    def gusts(self) -> float:
        """0..1: how much the speed varies."""
    def set(self, *, direction: Vec3 | float | None = None, speed: float | None = None, gusts: float | None = None, seconds: float = 0.0) -> None:
        """Change the wind, eased in over `seconds` of game time; saved with the game."""
