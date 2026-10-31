from parallax import Behavior, Color, Shape, behavior, move_toward, param

from game.components import Gate, Room
from game.rules import Rules


@behavior("gate", requires=[Gate, Shape])
class GateBars(Behavior):
    """Rises to shut while the gate is locked (tinted its key's colour) or either room is fighting, and sinks to
    open otherwise. Nothing ever tells a gate to open: it reads the rooms."""

    open_height: float = param(-4, unit="m")
    shut_height: float = param(0, unit="m")
    speed: float = param(6, unit="m/s")
    gate_color: Color = param(Color.hex("#6b5a4a"))

    def update(self, ctx, dt):
        gate = self.entity.get(Gate)
        shut = gate.locked or any(room.get(Room).fighting for room in gate.between)
        lock_colors = ctx.config(Rules).lock_colors
        self.entity.get(Shape).color = lock_colors[gate.lock % len(lock_colors)] if gate.locked else self.gate_color
        t = self.entity.transform
        target = self.shut_height if shut else self.open_height
        t.position = t.position.with_y(move_toward(t.position.y, target, self.speed * dt))
