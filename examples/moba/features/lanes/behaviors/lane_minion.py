from parallax import Behavior, Vec2, behavior, param, state
from parallax.nav import NavAgent

from features.fighting.feature import Attacker, Stats, chase, distance, nearest_enemy, walk_to
from features.lanes.components import Minion


@behavior("lane_minion", requires=[Minion, Attacker, NavAgent, Stats])
class LaneMinion(Behavior):
    """Marches its lane waypoint by waypoint and fights the nearest enemy that
    comes within reach: minion, champion, camp or structure. It drops a chase
    that drags it too far and picks up the march where it left off."""

    acquire_bonus: float = param(4, unit="m", doc="How far beyond attack range it notices enemies.")
    leash: float = param(9, unit="m")
    advance_radius: float = param(3.5, unit="m")
    waypoint: int = state(1)

    def update(self, ctx, dt):
        attacker = self.entity.get(Attacker)
        agent = self.entity.get(NavAgent)
        reach = self.entity.get(Stats).attack_range
        if attacker.target and distance(self.entity, attacker.target) > reach + self.leash:
            attacker.target = None
        if attacker.target is None:
            attacker.target = nearest_enemy(ctx, self.entity, reach + self.acquire_bonus)
        if attacker.target:
            if distance(self.entity, attacker.target) > reach:
                chase(agent, attacker.target)
            else:
                agent.stop()
            return
        path = self._path()
        goal = path[self.waypoint].to_ground()
        if (goal - self.entity.transform.position).flat().length() < self.advance_radius and self.waypoint < len(path) - 1:
            self.waypoint += 1
        walk_to(agent, goal)

    def _path(self) -> list[Vec2]:
        minion = self.entity.get(Minion)
        path = minion.lane.data.path
        return list(reversed(path)) if minion.backwards else path
