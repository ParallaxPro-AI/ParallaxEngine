"""Enemy attacks and hero abilities."""

from typing import Literal

from parallax import EffectRef, Localized, SoundRef, Tag, content, field

from features.combat.tags import Physical


@content("attack")
class AttackDef:
    """One telegraphed enemy blow: the shape it marks on the ground, how long it warns, where it lands."""

    shape: Literal["cone", "circle"] = field("cone")
    radius: float = field(3, min=0.5, unit="m")
    angle: float = field(95, min=10, max=360, unit="deg", doc="Width of a cone.")
    aim: Literal["self", "target"] = field("self", doc="Centred on the attacker, or where its target stood.")
    tell: float = field(0.7, min=0.1, unit="s", doc="Warning time before the blow lands.")
    damage_scale: float = field(1, min=0)
    warning: Localized = field(doc="Label on the marked ground; identical labels share one translation.")


@content("ability")
class AbilityDef:
    """A hero ability on slot 1 or 2. `wave` strikes a line ahead; `mend` heals the hero."""

    name: Localized = field()
    locked_hint: Localized = field(doc="Shown when the slot is pressed before the ability is learned.")
    slot: int = field(1, choices=[1, 2])
    form: Literal["wave", "mend"] = field("wave")
    mana_cost: float = field(20, min=0)
    cooldown: float = field(4, min=0, unit="s")
    damage: float = field(0, min=0)
    scaling_per_level: float = field(0, min=0, doc="Extra damage per level above 1, as a fraction.")
    kind: Tag = field(Physical, doc="Damage kind of the wave.")
    reach: float = field(10, unit="m")
    width: float = field(1.6, unit="m", doc="Half-width of the wave where it starts.")
    spread: float = field(0.25, doc="How much the half-width grows per metre travelled.")
    stagger: float = field(0, unit="s")
    heal: float = field(0, min=0)
    effect: EffectRef = field()
    sound: SoundRef = field()
    volume: float = field(1, min=0, max=1, doc="The volume the template casts it at.")
