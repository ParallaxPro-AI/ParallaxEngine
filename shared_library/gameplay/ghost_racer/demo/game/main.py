"""Demo host for ghost_racer: a runner that the test drives along x, and its ghost."""

from parallax import Behavior, Game, behavior, param, vec3
from project import Scenes

from game.lib.ghost_racer import GhostKeeper
from game.lib.time_trial import TrialClock


@behavior("demo_runner")
class DemoRunner(Behavior):
    speed: float = param(2.0)

    def update(self, ctx, dt):
        self.entity.transform.position += vec3(self.speed * dt, 0, 0)


game = Game(id="ghost_demo", title="Ghost racer demo", sdk="1.0", mode="2d",
            systems=[TrialClock, GhostKeeper], start_scene=Scenes.canyon)
