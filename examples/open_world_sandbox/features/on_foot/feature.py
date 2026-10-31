"""Sam on foot: moving, shooting, the armour vest and health, money, and coming back from WASTED or BUSTED.

Every hit is a plain `Health.damage`; the vest is `Health.shield`, so nothing can shoot around it.
"""

from parallax import Feature
from project import Scenes

from features.on_foot.actions import OnFootControls, in_a_car
from features.on_foot.components import Armour, Arsenal
from features.on_foot.config import StreetRules
from features.on_foot.content import WeaponDef
from features.on_foot.events import PlayerRecovered, WeaponFired
from features.on_foot.recovery import begin_recovery
from features.on_foot.resources import Location, Recovery, Setback, Wallet
from features.on_foot.systems import DamageNumbers, Locator, Pickups, Recovering, WeaponWheel
from features.on_foot.tags import Player

on_foot = Feature(
    "on_foot",
    requires=["interiors", "phone"],
    systems=[Locator, Pickups, Recovering, WeaponWheel, DamageNumbers],
    scenes=[Scenes.sunset_bay],
    doc="The player character, weapons, armour, the wallet, and recovering after WASTED or BUSTED.",
)

__all__ = [
    "Armour", "Arsenal", "Location", "OnFootControls", "Player", "PlayerRecovered", "Recovery", "Setback",
    "StreetRules", "Wallet", "WeaponDef", "WeaponFired", "begin_recovery", "in_a_car", "on_foot",
]
