"""Pacing and battlefield rules (config/battle.json)."""

from parallax import SoundRef, config, field


@config("battle")
class BattleRules:
    countdown: float = field(unit="s")
    wave_clear_pause: float = field(unit="s")
    spawn_ring: float = field(unit="m")
    map_half: float = field(unit="m")
    flawless_bonus: int
    upgrade_offers: int
    upgrade_auto_pick: float = field(unit="s", doc="Real seconds before the first card is taken for you.")
    fire_point_radius: float = field(unit="m")
    fire_point_damage_mul: float
    drum_trigger_radius: float = field(unit="m", doc="A shell bursting this close cooks a fuel drum off.")
    supply_radius: float = field(unit="m", doc="Drive this close to an ammo crate to refill the rack.")
    lock_assist: float = field(doc="A locked hull's hit radius is widened by this factor.")
    toast_seconds: float = field(unit="s")


@config("sounds")
class Sounds:
    """The template's whole palette (its battle cue map and tank controller): one cannon
    report, one ammo-rack clatter, one repair clank, served from the ParallaxPro asset
    store. Each call site sets the template's volume."""
    cannon: SoundRef = field(doc="Your gun, enemy guns, a hit on your hull, a fuel drum cooking off.")
    rack: SoundRef = field(doc="Reload done, resupply, a field upgrade.")
    repair: SoundRef
