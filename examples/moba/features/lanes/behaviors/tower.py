from parallax import Behavior, Entity, behavior

from features.fighting.feature import Attacker, Stats, distance, enemies_near
from features.lanes.components import Aggressor, Minion


@behavior("tower", requires=[Attacker, Stats])
class TowerTargeting(Behavior):
    """Chooses what the tower shoots. A champion in range who has just hit an
    allied champion comes first. Otherwise it keeps its current target, and a new
    target is the nearest minion, or the nearest champion if no minion is near."""

    def update(self, ctx, dt):
        attacker = self.entity.get(Attacker)
        enemies = enemies_near(ctx, self.entity, self.entity.transform.position, self.entity.get(Stats).attack_range)
        aggressors = [e for e in enemies if e.has(Aggressor) and e.get(Aggressor).until > ctx.time.now]
        minions = [e for e in enemies if e.has(Minion)]
        if aggressors:
            attacker.target = self._nearest(aggressors)
        elif attacker.target not in enemies:
            attacker.target = self._nearest(minions) or self._nearest(enemies)

    def _nearest(self, units: list[Entity]) -> Entity | None:
        return min(units, key=lambda e: distance(self.entity, e), default=None)
