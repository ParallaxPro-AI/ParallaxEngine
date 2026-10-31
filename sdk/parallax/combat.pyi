"""Combat plugin: health, damage, death, sides, status effects, projectiles.

Every hit goes through one pipeline, so nothing can skip it:
  1. invulnerability (`Health.invulnerable`) → blocked
  2. game modifiers, in the order given to `combat(modifiers=[...])`
  3. shield absorbs, then flat armor, then fractional armor (skipped if
     `hit.ignores_armor`); a hit that got through armor deals at least
     `combat(min_damage=...)`
  4. `Health.minimum` floor; `hit.lethal = False` also stops at 1
  5. Damaged emitted; Died at 0

Modifiers may change the hit and may write game state (e.g. wear down a plating
component) — they run once per hit, in order.

A modifier is `def resist_fire(ctx, hit: DamageHit) -> None` and may change `hit.amount`,
set `hit.blocked`, or read source/target/kind.
Damage kinds and sides are tags.

Projectiles: `ctx.combat.fire(Prefabs.arrow, at=bow_tip, direction=aim, source=player)`
launches a pooled `Projectile` that hurts what it hits through the same pipeline and, like
`area_damage`, never hits its source's side unless it has `friendly_fire`.
"""

from typing import Callable, Literal
from parallax import (
    ContentRef, Color, Context, EngineComponent, Entity, Localized, PrefabRef, Tag, Vec2, Vec3,
    component, content, event, field, record,
)

class DamageHit:
    """One hit travelling through the damage pipeline (mutable inside modifiers). Not
    `parallax.physics.RayHit`, what raycasts return."""
    target: Entity
    source: Entity | None
    kind: Tag | None
    point: Vec3 | None
    amount: float
    blocked: bool
    ignores_armor: bool
    lethal: bool

DamageModifier = Callable[[Context, DamageHit], None]


@component("health")
class Health(EngineComponent):
    current: float = field(100, min=0)
    max: float = field(100, min=1, modifiable=True)
    shield: float = field(0, min=0, doc="Absorbed before health.")
    flat_armor: float = field(0, min=0, modifiable=True, doc="Subtracted from every hit.")
    armor: float = field(0, min=0, max=1, modifiable=True, doc="Fraction of the remainder absorbed.")
    minimum: float = field(0, min=0, doc="Health never drops below this (training dummies).")
    invulnerable_after_hit: float = field(0, unit="s")
    destroy_on_death: bool = field(True)

    def damage(self, amount: float, *, source: Entity | None = None, kind: Tag | None = None,
               point: Vec3 | None = None, ignores_armor: bool = False, lethal: bool = True) -> float:
        """Runs the pipeline. Returns damage dealt to health."""
    def add_shield(self, amount: float, *, seconds: float | None = None, key: str = "shield") -> None:
        """A shield that expires by itself; same key replaces."""
    def drain(self, per_second: float, *, key: str, kind: Tag | None = None,
              tick: float = 0.5) -> None:
        """Continuous damage (starving, drowning, burning ground) applied every `tick`
        through the pipeline. Idempotent per key: calling it every frame with the same
        rate keeps one drain ticking; a new rate updates it; `per_second=0` stops it."""
    def heal(self, amount: float) -> float: ...
    def kill(self, *, source: Entity | None = None) -> None: ...
    def revive(self, *, health: float | None = None) -> None: ...
    def protect(self, seconds: float) -> None:
        """Invulnerable for a while (dodges, respawn grace). Saved."""
    @property
    def invulnerable(self) -> bool: ...
    @property
    def dead(self) -> bool: ...
    @property
    def fraction(self) -> float: ...
    @property
    def staggered(self) -> bool:
        """A strike's `stagger` is still running (block input, play the flinch)."""


@component("health_bar")
class HealthBar(EngineComponent):
    """A world-space bar over an entity showing its Health (and shield). Drawn by
    `hud()` (its nameplates panel); without it `check` warns (PP2553)."""
    offset: Vec3 = field()
    color: Color | None = field(None, doc="Used when no ally/enemy colour applies.")
    ally_color: Color | None = field(None, doc="Per viewer: used when the viewer's side matches.")
    enemy_color: Color | None = field(None)
    hide_when_full: bool = field(True)
    width: float | None = field(None, min=4, max=400, unit="px", doc="The bar's width on screen (None: the HUD's).")
    height: float | None = field(None, min=1, max=60, unit="px")
    background: Color | None = field(None, doc="The empty part of the bar (None: dark glass).")
    border: Color | None = field(None, doc="Its outline (None: a faint white line). Further looks: subclass NameplatesPanel.")


@component("side")
class Side(EngineComponent):
    """Which side an entity fights for. Different sides are enemies; no Side = neutral."""
    side: Tag = field()


@record
class StatModifier:
    """A modifier an effect applies while active: component type name + field."""
    component: str
    field: str
    multiply: float = field(1)
    add: float = field(0)

@content("status_effect")
class StatusEffectDef:
    """Built-in content kind; games add entries in content/status_effect/*.json."""
    name: Localized
    damage_per_second: float = field(0, doc="At strength 1.")
    damage_kind: Tag | None = field(None)
    tick: float = field(0.5, unit="s", doc="How often damage is applied (and Damaged emitted).")
    speed_multiplier: float = field(1, doc="At strength 1; applied as a stat modifier.")
    modifiers: list[StatModifier] = field([])
    tint: Color | None = field(None)
    stacking: str = field("refresh", choices=["refresh", "strongest", "stack"],
                          doc="refresh: reapplying resets duration; strongest: keep the higher "
                              "strength; stack: independent copies multiply.")
    resisted_by: Tag | None = field(None, doc="Entities with this tag are immune.")


@component("status_effects")
class StatusEffects(EngineComponent):
    """Timed status effects on an entity. Engine-managed; saved. (Particle effects are
    ctx.vfx's, not this.)"""
    def apply(self, effect: ContentRef[StatusEffectDef], seconds: float, *,
              strength: float = 1, source: Entity | None = None) -> None:
        """Strength scales damage and modifiers (tower level 3 poison = strength 1.5)."""
    def remove(self, effect: ContentRef[StatusEffectDef]) -> None: ...
    def has(self, effect: ContentRef[StatusEffectDef]) -> bool: ...
    def strength(self, effect: ContentRef[StatusEffectDef]) -> float:
        """0 when not active."""


@event("damaged", target="entity")
class Damaged:
    entity: Entity
    amount: float
    source: Entity | None
    kind: Tag | None
    point: Vec3 | None
    shield_absorbed: float

@event("died", target="entity")
class Died:
    entity: Entity
    source: Entity | None
    """The killer: the lethal hit's `source`."""

@event("healed", target="entity")
class Healed:
    entity: Entity
    amount: float

@event("effect_applied", target="entity")
class EffectApplied:
    entity: Entity
    effect: ContentRef[StatusEffectDef]

@event("effect_ended", target="entity")
class EffectEnded:
    entity: Entity
    effect: ContentRef[StatusEffectDef]


# ─────────────────────────────────────────────────────────────────────────────
# Melee strikes, lock-on, aim assist, impacts
# ─────────────────────────────────────────────────────────────────────────────

@content("strike")
class StrikeDef:
    """A melee strike (content/strike/*.json): a capsule from `offset` to `offset + reach`
    in the frame of the attacker's Model `socket` (None: the attacker), swept between frames
    while its window is open — `active` seconds after `Striker.strike`, or between the
    AnimationEvent markers `start_event` and `end_event`. Each target is hit at most once."""
    damage: float = field(10)
    kind: Tag | None = field(None)
    socket: str | None = field(None, doc="Model socket the capsule rides; None: the attacker itself.")
    offset: Vec3 = field(Vec3(0, 0, 0))
    reach: Vec3 = field(Vec3(0, 0, 1))
    radius: float = field(0.15, min=0, unit="m")
    active: list[float] = field([0, 0.2], unit="s", doc="[start, end] after strike(); unused with start_event/end_event.")
    start_event: str | None = field(None)
    end_event: str | None = field(None)
    duration: float | None = field(None, unit="s", doc="When the strike is over; None: at the window's end.")
    max_targets: int = field(0, min=0, doc="0: any number.")
    friendly_fire: bool = field(False)
    knockback: float = field(0, min=0, unit="N·s", doc="Impulse along the swing on dynamic bodies.")
    stagger: float = field(0, min=0, unit="s", doc="Health.staggered on the target for this long.")
    reaction: str | None = field(None, doc="Animator trigger fired on the target (when it has an Animator).")


@component("striker")
class Striker(EngineComponent):
    """Swings strikes. One at a time: a new strike replaces the one under way."""
    def strike(self, strike: ContentRef[StrikeDef]) -> None: ...
    def cancel(self) -> None: ...
    @property
    def active(self) -> bool:
        """The window is open (the capsule can hit now)."""
    @property
    def striking(self) -> bool: ...
    @property
    def current(self) -> ContentRef[StrikeDef] | None: ...


@record
class HurtZone:
    """A capsule from `offset` up `length` meters along the socket's +y."""
    name: str = field("")
    socket: str | None = field(None, doc="Model socket (a bone); None: the entity itself.")
    offset: Vec3 = field(Vec3(0, 0, 0))
    length: float = field(0, min=0, unit="m")
    radius: float = field(0.3, min=0, unit="m")
    multiplier: float = field(1, min=0, doc="Damage multiplier (2 for a head).")

@component("hurtbox")
class Hurtbox(EngineComponent):
    """Where strikes land. Without one: a standing capsule filling the Collider (else 1.8 m)."""
    zones: list[HurtZone] = field([])


@component("lock_on")
class LockOn(EngineComponent):
    """Target lock for the entity holding it. Candidates: living enemies (anything with
    Health when the holder has no Side) within `range` and `angle` of its facing, in sight
    (physics3d). The lock lets go when the target dies, leaves `break_range` or sight."""
    range: float = field(25, min=0, unit="m")
    angle: float = field(60, min=0, max=180, unit="deg")
    break_range: float = field(35, min=0, unit="m")
    line_of_sight: bool = field(True)
    target: Entity | None = field(None, doc="Kept by the engine.")

    def lock(self) -> bool: ...
    def cycle(self, direction: int = 1) -> bool:
        """Next target clockwise (1) or anticlockwise (-1) around the holder."""
    def release(self) -> None: ...
    @property
    def locked(self) -> bool: ...


@component("impact_damage")
class ImpactDamage(EngineComponent):
    """Hits from the world into this entity's Health: physics3d contacts pressing over
    `threshold` newtons deal force / threshold (source: what it hit); with `from_breakable`,
    the destruction plugin's BreakableDamaged on this entity is mirrored too."""
    threshold: float | None = field(None, min=0, unit="N")
    min_speed: float = field(0, min=0, unit="m/s")
    kind: Tag | None = field(None)
    from_breakable: bool = field(False)


@event("strike_hit", target="entity")
class StrikeHit:
    entity: Entity
    """The one hit."""
    source: Entity
    """The attacker."""
    strike: ContentRef[StrikeDef]
    point: Vec3
    zone: str
    damage: float
    reaction: str | None

@event("lock_changed", target="entity")
class LockChanged:
    entity: Entity
    """The holder."""
    target: Entity | None
    previous: Entity | None


class CombatApi:
    def are_enemies(self, a: Entity, b: Entity) -> bool: ...
    def area_damage(self, center: Vec3, radius: float, amount: float, *,
                    source: Entity | None = None, kind: Tag | None = None,
                    falloff: bool = True, friendly_fire: bool = False) -> list[Entity]:
        """Damage every Health in range through the pipeline. `source` gets kill credit;
        `friendly_fire` controls whether the source's side is hit. Returns those hit."""
    def aim_assist(self, origin: Vec3, direction: Vec3, *, shooter: Entity | None = None,
                   angle: float = 8, range: float = 100, strength: float = 0.5) -> Vec3:
        """`direction` bent towards the nearest enemy aim point within `angle` degrees, by
        `strength` (0: unchanged, 1: straight at it). In sight of `shooter` (physics3d)."""
    def aim_target(self, origin: Vec3, direction: Vec3, *, shooter: Entity | None = None,
                   angle: float = 8, range: float = 100) -> Entity | None:
        """The enemy aim assist would bend towards (use it to slow the look: friction)."""
    def fire(self, prefab: PrefabRef, *, at: Vec3 | Vec2, direction: Vec3 | Vec2 | None = None,
             velocity: Vec3 | Vec2 | None = None, speed: float | None = None,
             source: Entity | None = None, target: Entity | None = None) -> Entity:
        """Launch the prefab's Projectile (a pooled one of that prefab when one is free).
        Exactly one of `direction` or `velocity`; `speed` None: the prefab's
        Projectile.speed. `source` gets kill credit, is never hit, and its Side's members
        are flown through unless the projectile has `friendly_fire`."""


# ─────────────────────────────────────────────────────────────────────────────
# Projectiles
# ─────────────────────────────────────────────────────────────────────────────

@component("projectile")
class Projectile(EngineComponent):
    """A shot launched with `ctx.combat.fire`: flies straight, ballistic or homing, sweeps
    for hits each physics step, and hurts a target's Health through the damage pipeline.
    Like `area_damage`, it respects sides: entities on its source's Side are flown through
    (never hit) unless `friendly_fire`. Retired projectiles are pooled and reused by the
    next shot of the same prefab."""
    motion: Literal["straight", "ballistic", "homing"] = field("straight")
    speed: float = field(20, min=0, unit="m/s")
    gravity: float | None = field(None, unit="m/s²", doc="ballistic; None: the physics world's.")
    turn_rate: float = field(180, min=0, unit="deg/s", doc="homing.")
    lifetime: float = field(3, min=0, unit="s")
    radius: float = field(0, min=0, unit="m", doc="0: a ray.")
    damage: float = field(0, min=0, doc="Dealt through the target's Health.")
    damage_kind: Tag | None = field(None)
    pierce: int = field(0, min=0, doc="Targets it flies through before the next one stops it.")
    layers: list[str] = field([], doc="Collision layers it hits; empty: all.")
    friendly_fire: bool = field(False, doc="Also hit (and hurt) entities on the source's Side.")
    active: bool = field(True, doc="False while pooled (kept by the engine).")
    velocity: Vec3 = field(Vec3(0, 0, 0), doc="Kept by the engine.")
    age: float = field(0, min=0, doc="Kept by the engine.")
    source: Entity | None = field(None, doc="Kept by the engine.")
    target: Entity | None = field(None, doc="Kept by the engine.")
    hits: list[Entity] = field([], doc="Kept by the engine.")

    def retire(self) -> None:
        """Put it back in the pool now."""


@event("projectile_hit", target="entity")
class ProjectileHit:
    entity: Entity
    """The projectile."""
    target: Entity | None
    """None: scenery (terrain, the block world)."""
    point: Vec3
    normal: Vec3

@event("projectile_expired", target="entity")
class ProjectileExpired:
    entity: Entity
