from parallax import Behavior, Game, behavior, state
from parallax.plugins import physics2d
from project import Scenes


@behavior("counter")
class Counter(Behavior):
    ticks: int = state(0)

    def update(self, ctx, dt: float) -> None:
        self.ticks += 1


game = Game(
    id="drop",
    title="Drop",
    sdk="1.0",
    mode="2d",
    plugins=[physics2d(gravity=-10)],
    start_scene=Scenes.main,
)
