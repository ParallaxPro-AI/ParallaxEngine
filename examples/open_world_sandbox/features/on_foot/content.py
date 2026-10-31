"""Weapons."""

from parallax import Localized, SoundRef, content, field


@content("weapon")
class WeaponDef:
    """One weapon. `melee` weapons hit what is in front; the rest fire `pellets` rays per shot."""

    name: Localized = field()
    melee: bool = field(False)
    damage: float = field(10, min=0)
    range: float = field(50, min=1, unit="m")
    interval: float = field(0.3, min=0.05, unit="s", doc="Time between shots or punches.")
    magazine: int = field(12, min=0)
    reserve_max: int = field(120, min=0)
    reload_time: float = field(1.4, min=0, unit="s")
    pellets: int = field(1, min=1)
    spread: float = field(1.5, min=0, unit="deg")
    sound: SoundRef = field()
    volume: float = field(1, min=0, max=1)
