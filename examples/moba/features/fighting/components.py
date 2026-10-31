from parallax import EffectRef, Entity, component, field

from game.content import Clips


@component("stats")
class Stats:
    """A unit's numbers besides health, armor and speed, which are the engine's own
    modifiable fields (`Health.max`, `Health.armor`, `NavAgent.speed`). Every field
    is modifiable: items, buffs and jungle rewards stack on it (`add_stats`), and
    reading it gives the effective value. Slows are status effects, not stats."""
    max_mana: float = field(0, modifiable=True, replicate="team")
    mana_regen: float = field(0, modifiable=True)
    damage: float = field(0, modifiable=True)
    ability_power: float = field(0, modifiable=True)
    attack_range: float = field(0, unit="m", modifiable=True, replicate="owner", doc="Read by the predicted HeroMotor.")
    attack_interval: float = field(0, unit="s", modifiable=True)
    dash_bonus: float = field(0, unit="m", modifiable=True)


@component("attacker")
class Attacker:
    """Who this unit is swinging at. Brains (player, bot, minion, tower) set the
    target; the basic_attack behavior swings."""
    target: Entity | None = field(None, replicate=True)
    ready_at: float = field(0, unit="s")
    bolt: EffectRef | None = field(None, doc="Effect shown at the target when a ranged attack lands.")


@component("animations")
class Animations:
    """Which clip plays for what. Champions get theirs from the draft."""
    clips: Clips = field(Clips(), replicate=True)
