from parallax import Behavior, Vec3, behavior, on, param, state, wrap_angle
from parallax.characters import Character
from parallax.combat import Damaged


@behavior("grazer", requires=[Character])
class Grazer(Behavior):
    """Ambles, stops to graze, turns and ambles again. When hurt, it runs away
    from whatever hit it for a few seconds."""

    stroll_seconds: float = param(3, unit="s")
    graze_seconds: float = param(2, unit="s")
    turn: float = param(97, unit="deg")
    flee_seconds: float = param(5, unit="s")
    heading: float = state(0.0)
    phase_left: float = state(0.0)
    flee_left: float = state(0.0)
    flee_from: Vec3 = state(Vec3.ZERO)

    def update(self, ctx, dt):
        body = self.entity.get(Character)
        here = self.entity.transform.position
        self.flee_left = max(0.0, self.flee_left - dt)
        if self.flee_left > 0:
            body.move((here - self.flee_from).flat().normalized(), run=True)
            return
        self.phase_left -= dt
        if self.phase_left <= 0:
            self.heading = wrap_angle(self.heading + self.turn)
            self.phase_left = self.stroll_seconds + self.graze_seconds
        if self.phase_left > self.graze_seconds:
            body.move(Vec3.from_yaw_pitch(self.heading))
        else:
            body.stop()

    @on(Damaged)
    def startled(self, ctx, event: Damaged):
        self.flee_left = self.flee_seconds
        self.flee_from = event.source.transform.position if event.source else self.entity.transform.position
