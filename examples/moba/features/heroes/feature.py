"""Heroes: champions as data (kit, progression, mana), the orders that drive them,
recall, the fountain and respawning."""

from parallax import Feature

from features.heroes.behaviors.hero_motor import HeroMotor
from features.heroes.behaviors.player_orders import PlayerOrders
from features.heroes.components import AbilityBook, Fountain, Hero, Mana, Orders, Progression
from features.heroes.events import CastRequested, LeveledUp, RankUpRequested, RecallRequested, WardRequested
from features.heroes.loadout import equip_champion
from features.heroes.places import fountain_of
from features.heroes.progression import grant_xp, rank_cap, xp_to_next
from features.heroes.rpcs import recall
from features.heroes.systems.hero_upkeep import HeroUpkeep
from features.heroes.systems.respawns import Respawns

heroes = Feature(
    "heroes",
    requires=["fighting"],
    systems=[HeroUpkeep, Respawns],
    doc="Champion data, orders, recall, fountain and respawn.",
)

__all__ = [
    "heroes", "HeroMotor", "PlayerOrders", "AbilityBook", "Fountain", "Hero", "Mana", "Orders", "Progression",
    "CastRequested", "LeveledUp", "RankUpRequested", "RecallRequested", "WardRequested",
    "equip_champion", "fountain_of", "grant_xp", "rank_cap", "recall", "xp_to_next",
]
