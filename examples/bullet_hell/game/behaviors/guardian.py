import math
import random

from parallax import Behavior, Color, Sprite, Timer, behavior, clamp, on, param, state, vec2
from parallax.combat import Died, Health
from project import Prefabs

from game.audio import Sounds, play
from game.build import find_wisp
from game.components import Drift, Guardian
from game.config import Arena
from game.content import Fire, Flight
from game.events import GuardianEscaped
from game.patterns import volley


@behavior("guardian", requires=[Guardian, Health, Sprite])
class GuardianFlight(Behavior):
    """Flies one guardian through its wave's flight pattern and fires its scripted
    petal pattern. Sway sweeps side to side while drifting down; plunge eases in,
    then dives at the Wisp; vee holds a slow V; root and sovereign take up a firing
    line near the top and stay. A guardian that slips off the bottom escapes; a
    banished one stops flying and firing while it shrinks away."""

    first_volley: tuple[float, float] = param((0.7, 2.0), unit="s", doc="Delay before its first volley.")
    volley_jitter: tuple[float, float] = param((0.6, 1.4), doc="Scales the wave's fire rate per volley.")
    muzzle_drop: float = param(0.3, unit="m")
    hover_top: float = param(4.6, unit="m", doc="Firing line for root guardians; rows step down from here.")
    hover_step: float = param(0.95, unit="m")
    boss_hover: float = param(5.0, unit="m")
    dive_line: float = param(4.0, unit="m", doc="Plunging guardians dive below this.")
    dive_boost: float = param(2.6, unit="m/s")
    dive_steer: float = param(0.9, doc="How hard a dive turns toward the Wisp (per second).")
    vee_sway: float = param(0.4, unit="m")
    bob: float = param(0.18, unit="m", doc="Root guardians bob this much on their firing line.")
    bob_rate: float = param(1.6, doc="Radians per second.")
    boss_bob: float = param(0.4, unit="m")
    boss_bob_rate: float = param(0.8, doc="Radians per second.")
    banish_seconds: float = param(0.3, unit="s")
    telegraph_color: Color = param(Color.hex("#ff80b3"), doc="Flash as it fires.")
    telegraph_seconds: float = param(0.15, unit="s")

    age: float = state(0.0)
    home_x: float = state(0.0)
    hover_y: float = state(0.0)
    spin: float = state(0.0)
    volleys: int = state(0)
    reload: Timer = state(Timer.cooldown(0))

    def start(self, ctx):
        guardian = self.entity.get(Guardian)
        kind = guardian.kind.data
        self.home_x = self.entity.transform.position.x
        self.hover_y = self.boss_hover if kind.boss else self.hover_top - self.hover_step * (guardian.slot % 3)
        self.spin = random.uniform(0, 360)
        self.reload.restart(random.uniform(*self.first_volley))
        self.entity.transform.scale = kind.scale
        self.entity.get(Sprite).play(kind.animation)

    def update(self, ctx, dt):
        if self.entity.get(Health).dead:
            return
        self.age += dt
        self.fly(ctx, dt)
        if self.entity.transform.position.y < ctx.config(Arena).escape_line:
            ctx.emit(GuardianEscaped())
            self.entity.destroy()
            return
        self.fire(ctx, dt)

    @on(Died)
    def banished(self, ctx, event: Died):
        self.entity.transform.scale_to(0, self.banish_seconds, ease="in_quad")
        self.entity.destroy(after=self.banish_seconds)

    def fly(self, ctx, dt):
        wave = self.entity.get(Guardian).wave.data
        tf = self.entity.transform
        x, y = tf.position.x, tf.position.y
        sweep = wave.amp * math.sin(self.age * wave.freq * math.pi)
        if wave.flight is Flight.SWAY:
            y -= wave.speed * dt
            x = self.home_x + sweep
        elif wave.flight is Flight.PLUNGE:
            if y > self.dive_line:
                y -= wave.speed * dt
                x = self.home_x + sweep
            else:
                y -= (wave.speed + self.dive_boost) * dt
                target = find_wisp(ctx).transform.position.x
                x += (target - x) * min(1.0, dt * self.dive_steer)
        elif wave.flight is Flight.VEE:
            y -= wave.speed * dt
            x = self.home_x + self.vee_sway * math.sin(self.age * wave.freq * math.pi)
        elif y > self.hover_y:  # root and sovereign descend to their firing line...
            y -= wave.speed * dt
        elif wave.flight is Flight.ROOT:  # ...then hold it, bobbing
            y = self.hover_y + self.bob * math.sin(self.age * self.bob_rate)
            x = self.home_x + sweep
        else:
            y = self.hover_y + self.boss_bob * math.sin(self.age * self.boss_bob_rate)
            x = sweep
        edge = ctx.config(Arena).field_half_width + 0.2
        tf.position = vec2(clamp(x, -edge, edge), y)

    def fire(self, ctx, dt):
        guardian = self.entity.get(Guardian)
        kind, wave = guardian.kind.data, guardian.wave.data
        if wave.fire_rate <= 0 or kind.fire is Fire.NONE or not self.reload.tick(dt):
            return
        self.reload.restart(wave.fire_rate * random.uniform(*self.volley_jitter))
        origin = self.entity.transform.position.xy() - vec2(0, self.muzzle_drop)
        target = find_wisp(ctx).transform.position.xy()
        for velocity in volley(kind, origin, target, self.spin, self.volleys):
            ctx.world.spawn(Prefabs.petal, at=origin, components=[Drift(velocity=velocity)])
        self.spin += kind.spin_step
        self.volleys += 1
        ctx.ui.flash(self.entity, color=self.telegraph_color, seconds=self.telegraph_seconds)
        play(ctx, ctx.config(Sounds).petal_volley)
