"""The hero's sword."""

from parallax import Animator, Behavior, angle_between, behavior, heading_to, param, state, vec2, vec3
from parallax.characters import Character
from parallax.combat import Health
from project import Assets

from features.combat.actions import CombatControls
from features.combat.components import Offense
from features.combat.events import Staggered
from features.combat.tags import Hostile
from game.audio import Sounds, play


@behavior("hero_sword", requires=[Offense, Character, Animator, Health])
class HeroSword(Behavior):
    """Hold Strike to swing toward where the camera looks. The blade connects mid-swing with every
    hostile in the arc ahead, at the damage, rate and element the loadout gives it. No swinging mid-dodge."""

    reach: float = param(3.6, unit="m")
    arc: float = param(160, unit="deg")
    impact_at: float = param(0.19, unit="s", doc="Seconds into the swing when the blade connects.")
    stagger: float = param(0.18, unit="s")
    cooldown: float = state(0.0)
    swing: float = state(0.0)
    connected: bool = state(True)

    def update(self, ctx, dt):
        self.cooldown = max(0.0, self.cooldown - dt)
        health = self.entity.get(Health)
        if health.dead:
            return
        if not self.connected:
            self.swing += dt
            if self.swing >= self.impact_at:
                self.connected = True
                self.connect(ctx)
        elif ctx.input.held(CombatControls.strike) and self.cooldown == 0 and not health.invulnerable:
            self.begin(ctx)

    def begin(self, ctx):
        origin = self.entity.transform.position
        ahead = ctx.camera.main.relative(vec2(0, 1))
        self.entity.get(Character).face(heading_to(origin, origin + ahead))
        self.entity.get(Animator).play_once(Assets.clips.overhead_swing)
        self.cooldown = 1 / self.entity.get(Offense).attack_rate
        self.swing = 0.0
        self.connected = False

    def connect(self, ctx):
        origin = self.entity.transform.position
        facing = self.entity.transform.forward.flat()
        offense = self.entity.get(Offense)
        hits = 0
        for foe, health in ctx.world.query(Health, tagged=Hostile).near(origin, self.reach):
            offset = (foe.transform.position - origin).flat()
            if health.dead or (offset.length() > 0.8 and angle_between(facing, offset) > self.arc / 2):
                continue
            health.damage(offense.damage, source=self.entity, kind=offense.element)
            ctx.emit(Staggered(entity=foe, seconds=self.stagger))
            hits += 1
        ctx.vfx.play(Assets.vfx.sword_arc, at=origin + facing * 1.7 + vec3(0, 1, 0))
        sounds = ctx.config(Sounds)
        play(ctx, sounds.sword_hit if hits else sounds.sword_miss)
        if hits:
            ctx.camera.main.shake(0.045, 0.07)
