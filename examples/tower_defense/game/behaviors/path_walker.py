from parallax import Behavior, behavior, heading_to, param, state, vec3

from game.components import Invader, Route
from game.events import EnemyLeaked


@behavior("path_walker", requires=[Invader])
class PathWalker(Behavior):
    """Walks the battlefield's route point by point at the invader's speed (a chill
    lowers it as a stat modifier). Reaching the last point means it got through to
    the keep."""

    arrive_radius: float = param(1.0, unit="m")

    next_point: int = state(1)

    def update(self, ctx, dt):
        _, route = ctx.world.query(Route).single()
        position = self.entity.transform.position
        goal = route.points[self.next_point]
        to_goal = (goal - position).flat()
        if to_goal.length() < self.arrive_radius:
            self.next_point += 1
            if self.next_point == len(route.points):
                ctx.emit(EnemyLeaked(enemy=self.entity))
                self.entity.destroy()
            return
        speed = self.entity.get(Invader).speed
        self.entity.transform.position = position + to_goal.normalized() * speed * dt
        self.entity.transform.euler = vec3(0, heading_to(position, goal), 0)
