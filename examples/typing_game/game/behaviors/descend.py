from parallax import Behavior, behavior, vec3
from project import Placed

from game.components import Word
from game.events import WordBreached
from game.rules import fall_speed


@behavior("descend", requires=[Word])
class Descend(Behavior):
    """Slides the packet toward the firewall at the run's fall speed (times its
    kind's), and reports a breach the moment it crosses."""

    def update(self, ctx, dt):
        word = self.entity.get(Word)
        transform = self.entity.transform
        transform.position += vec3(0, 0, fall_speed(ctx) * word.kind.data.speed_mult * dt)
        if transform.position.z >= ctx.world.placed(Placed.firewall).transform.position.z:
            ctx.emit(WordBreached(at=transform.position, kind=word.kind))
            self.entity.destroy()
