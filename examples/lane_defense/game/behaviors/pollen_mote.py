from parallax import Behavior, behavior, param, state

from game.events import PollenCollected


@behavior("pollen_mote")
class PollenMote(Behavior):
    """A mote of pollen. It drifts down to the lawn, can be clicked to collect it early,
    is gathered by itself shortly after landing, and fades if left too long."""

    amount: int = param(25, min=1)
    fall_speed: float = param(1.8, unit="m/s")
    rest_height: float = param(0.45, unit="m")
    gather_after_landing: float = param(1.5, unit="s")
    lifetime: float = param(9, unit="s")

    landed_at: float = state(-1.0)

    def start(self, ctx):
        self.entity.destroy(after=self.lifetime)

    def update(self, ctx, dt):
        pointer = ctx.input.pointer
        if pointer.pressed and pointer.over == self.entity:
            self.collect(ctx)
            return
        position = self.entity.transform.position
        if position.y > self.rest_height:
            self.entity.transform.position = position.with_y(max(self.rest_height, position.y - self.fall_speed * dt))
        elif self.landed_at < 0:
            self.landed_at = ctx.time.now
        elif ctx.time.now - self.landed_at >= self.gather_after_landing:
            self.collect(ctx)

    def collect(self, ctx):
        ctx.emit(PollenCollected(amount=self.amount, at=self.entity.transform.position))
        self.entity.destroy()
