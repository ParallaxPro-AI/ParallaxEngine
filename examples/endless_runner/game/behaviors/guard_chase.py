"""The guard on your heels."""

from parallax import Animator, Behavior, ClipRef, behavior, lerp, on, param, vec3

from game.components import Runner
from game.events import RunEnded
from game.resources import Run


@behavior("guard_chase", requires=[Animator])
class GuardChase(Behavior):
    """Rides exactly `Run.guard_gap` metres behind the runner and drifts into
    the runner's lane, so the gap (the run's health bar) is something you can
    see over your shoulder. When the gap closes he grabs you."""

    lane_follow: float = param(6, doc="1/s; how quickly he matches your lane.")
    won_clip: ClipRef = param(doc="Played when you get away (the model's own clip).")
    caught_clip: ClipRef = param(doc="Played when he grabs you.")

    def late_update(self, ctx, dt):
        runner, _ = ctx.world.query(Runner).single()
        target = runner.transform.position
        here = self.entity.transform.position
        x = lerp(here.x, target.x, min(1.0, self.lane_follow * dt))
        self.entity.transform.position = vec3(x, 0, target.z - ctx.get(Run).guard_gap)

    @on(RunEnded)
    def ended(self, ctx, event: RunEnded):
        self.entity.get(Animator).play(self.won_clip if event.won else self.caught_clip, loop=event.won)
