from parallax import Behavior, Vec3, behavior, on, param, state
from parallax.combat import Damaged, Died, Health
from parallax.nav import NavAgent

from features.economy.feature import Bounty
from features.fighting.feature import Attacker, Stats, chase, distance, set_base, walk_to
from features.jungle.components import Camp


@behavior("neutral_camp", requires=[Camp, Attacker, Health, NavAgent, Stats])
class NeutralCamp(Behavior):
    """A jungle monster. It waits at its post until attacked, fights back for a
    few seconds after each hit, and walks home if pulled past its leash. When
    killed it vanishes and returns to its post a while later."""

    leash: float = param(15, unit="m")
    aggro_seconds: float = param(7, unit="s")
    post: Vec3 = state(Vec3.ZERO)
    calm_at: float = state(0.0)
    returns_at: float = state(0.0)

    def start(self, ctx):
        self.post = self.entity.transform.position
        camp = self.entity.get(Camp).kind.data
        set_base(self.entity, camp.stats)
        self.entity.add(Bounty(gold=camp.gold, xp=camp.xp, reward=camp.reward, announcement=camp.taken))

    @on(Damaged)
    def provoked(self, ctx, event: Damaged):
        self.entity.get(Attacker).target = event.source
        self.calm_at = ctx.time.now + self.aggro_seconds

    @on(Died)
    def slain(self, ctx, event: Died):
        self.returns_at = ctx.time.now + self.entity.get(Camp).kind.data.respawn

    def update(self, ctx, dt):
        health = self.entity.get(Health)
        agent = self.entity.get(NavAgent)
        self.entity.visible = not health.dead
        if health.dead:
            agent.stop()
            if ctx.time.now >= self.returns_at:
                self.entity.transform.position = self.post
                health.revive()
            return
        attacker = self.entity.get(Attacker)
        if ctx.time.now > self.calm_at or (self.entity.transform.position - self.post).length() > self.leash:
            attacker.target = None
        if attacker.target is None:
            walk_to(agent, self.post)
        elif distance(self.entity, attacker.target) > self.entity.get(Stats).attack_range:
            chase(agent, attacker.target)
        else:
            agent.stop()
