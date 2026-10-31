"""Small authored encounters: tell, commit, recover."""

from parallax import (
    Behavior, ContentRef, Entity, Quat, Vec3, angle_between, behavior, heading_to, on, param, state, vec3,
)
from parallax.combat import Damaged, Health
from parallax.nav import NavAgent
from project import Assets, Prefabs

from features.combat.components import Threat
from features.combat.content import AttackDef
from features.combat.events import Staggered
from features.combat.tags import Hostile, Physical
from features.hero.feature import Hero


@behavior("encounter_enemy", requires=[Health, Threat, NavAgent], tick="significance")
class EncounterEnemy(Behavior):
    """Closes in on its target, marks the ground where the next blow will land, then commits.

    The blow hits whoever is standing in the marked shape when the tell runs out — the hero, Ember,
    or both — so every attack can be dodged or walked out of. Attacks cycle through `attacks`, one per
    beat. The target is the hero unless a taunt (Ember's bite) holds this enemy's attention.
    """

    attacks: list[ContentRef[AttackDef]] = param([], doc="Cycled one per beat.")
    damage: float = param(14, min=0)
    reach: float = param(2.7, unit="m", doc="Distance it closes to before it swings.")
    detect_range: float = param(15, unit="m")
    leash_range: float = param(28, unit="m")
    recover: float = param(1.3, unit="s")
    enrage_below: float = param(0, min=0, max=1, doc="Below this health fraction it recovers faster.")
    enraged_recover: float = param(0.8, unit="s")
    poise: float = param(0, unit="s", doc="Staggers shorter than this are shrugged off.")
    windup_poise: float = param(0.5, unit="s", doc="Staggers shorter than this cannot cancel a windup.")

    beat: int = state(0)
    current: ContentRef[AttackDef] | None = state(None)
    windup: float = state(0.0)
    recovering: float = state(0.7)
    staggered: float = state(0.0)
    aim_point: Vec3 = state(Vec3.ZERO)
    aim_yaw: float = state(0.0)
    telegraph: Entity | None = state(None)

    def end(self, ctx):
        self.clear_telegraph()

    @on(Damaged)
    def provoked(self, ctx, event: Damaged):
        self.entity.get(Threat).engaged = True

    @on(Staggered)
    def stagger(self, ctx, event: Staggered):
        threshold = max(self.poise, self.windup_poise) if self.windup > 0 else self.poise
        if event.seconds < threshold:
            return
        self.windup = 0.0
        self.staggered = event.seconds
        self.recovering = max(self.recovering, event.seconds + 0.3)
        self.clear_telegraph()

    def update(self, ctx, dt):
        self.recovering = max(0.0, self.recovering - dt)
        self.staggered = max(0.0, self.staggered - dt)
        threat = self.entity.get(Threat)
        threat.taunt.tick(dt)
        target = self.pick_target(ctx, threat)
        if target is None:
            self.disengage(threat)
            return
        distance = self.entity.transform.position.distance_to(target.transform.position)
        if distance > self.leash_range or (not threat.engaged and distance > self.detect_range):
            self.disengage(threat)
            return
        threat.engaged = True
        if self.staggered > 0:
            return
        if self.windup > 0:
            self.windup -= dt
            if self.windup <= 0:
                self.impact(ctx)
            return
        if self.recovering > 0:
            return
        agent = self.entity.get(NavAgent)
        if distance > self.reach:
            agent.move_to(target)
        else:
            agent.stop()
            self.begin_attack(ctx, target)

    def pick_target(self, ctx, threat: Threat) -> Entity | None:
        """The taunter while a taunt holds and it is standing, otherwise the hero if alive."""
        taunter = threat.taunter
        if not threat.taunt.done and taunter is not None and taunter.alive and not taunter.get(Health).dead:
            return taunter
        hero, health = ctx.world.query(Health, tagged=Hero).single()
        return None if health.dead else hero

    def disengage(self, threat: Threat):
        threat.engaged = False
        self.windup = 0.0
        self.entity.get(NavAgent).stop()
        self.clear_telegraph()

    def begin_attack(self, ctx, target: Entity):
        attack_ref = self.attacks[self.beat % len(self.attacks)]
        attack = attack_ref.data
        self.beat += 1
        self.current = attack_ref
        origin = self.entity.transform.position
        self.aim_yaw = heading_to(origin, target.transform.position)
        self.aim_point = target.transform.position if attack.aim == "target" else origin
        self.entity.transform.euler = vec3(0, self.aim_yaw, 0)
        self.windup = attack.tell
        prefab = Prefabs.telegraph_circle if attack.shape == "circle" else Prefabs.telegraph_cone
        self.telegraph = ctx.world.spawn(prefab, at=ctx.terrain.ground(self.aim_point), rotation=vec3(0, self.aim_yaw, 0))
        self.telegraph.transform.scale = vec3(attack.radius * 2, 1, attack.radius * 2)
        ctx.ui.label(self.telegraph, attack.warning, kind="telegraph")

    def impact(self, ctx):
        if self.current is None:
            return
        attack = self.current.data
        facing = Quat.from_euler(vec3(0, self.aim_yaw, 0)).rotate(Vec3.FORWARD)
        for victim, health in ctx.world.query(Health, without=[Hostile]).near(self.aim_point, attack.radius):
            offset = (victim.transform.position - self.aim_point).flat()
            outside_cone = attack.shape == "cone" and angle_between(facing, offset) > attack.angle / 2
            if not health.dead and not outside_cone:
                health.damage(self.damage * attack.damage_scale, source=self.entity, kind=Physical)
        ctx.vfx.play(Assets.vfx.ground_impact, at=ctx.terrain.ground(self.aim_point) + vec3(0, 0.3, 0), scale=attack.radius / 3)
        self.clear_telegraph()
        enraged = self.entity.get(Health).fraction < self.enrage_below
        self.recovering = self.enraged_recover if enraged else self.recover

    def clear_telegraph(self):
        if self.telegraph is not None and self.telegraph.alive:
            self.telegraph.destroy()
        self.telegraph = None
