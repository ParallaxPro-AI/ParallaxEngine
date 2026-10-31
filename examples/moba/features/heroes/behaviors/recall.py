from parallax import Animator, Behavior, Vec3, behavior, on, param, state
from parallax.combat import Damaged, Health
from parallax.nav import NavAgent

from features.fighting.feature import Animations, Attacker
from features.heroes.components import Hero, Orders
from features.heroes.events import CastRequested, RecallRequested
from features.heroes.places import fountain_of
from game.config import MatchRules


@behavior("recall", requires=[Hero, Orders, NavAgent, Health])
class Recall(Behavior):
    """Channels home. Standing still and unhurt for the whole channel teleports
    the champion to its fountain. Moving, casting or taking damage breaks it."""

    move_tolerance: float = param(0.4, unit="m")
    started_from: Vec3 = state(Vec3.ZERO)

    @on(RecallRequested)
    def begin(self, ctx, event: RecallRequested):
        hero = self.entity.get(Hero)
        if self.entity.get(Health).dead or hero.recall_at:
            return
        hero.recall_at = ctx.time.now + ctx.config(MatchRules).recall_seconds
        self.started_from = self.entity.transform.position
        self.entity.get(Orders).destination = None
        self.entity.get(Attacker).target = None
        self.entity.get(Animator).play(self.entity.get(Animations).clips.recall)

    @on(Damaged)
    def hurt(self, ctx, event: Damaged):
        self.entity.get(Hero).recall_at = 0

    @on(CastRequested)
    def cast(self, ctx, event: CastRequested):
        self.entity.get(Hero).recall_at = 0

    def update(self, ctx, dt):
        hero = self.entity.get(Hero)
        if not hero.recall_at:
            return
        if (self.entity.transform.position - self.started_from).length() > self.move_tolerance:
            hero.recall_at = 0
        elif ctx.time.now >= hero.recall_at:
            hero.recall_at = 0
            self.entity.transform.position = fountain_of(ctx, self.entity).transform.position
            self.entity.get(NavAgent).stop()
