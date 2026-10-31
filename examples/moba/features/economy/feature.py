"""Economy: gold, bounties, passive income and the item shop."""

from parallax import Feature
from project import Scenes

from features.economy.components import Bounty, Items, Wallet
from features.economy.rpcs import buy_item
from features.economy.systems.bounties import Bounties
from features.economy.systems.income import Income
from features.economy.ui import ShopPanel, stat_lines

economy = Feature(
    "economy",
    requires=["heroes", "fighting"],
    systems=[Bounties, Income],
    scenes=[Scenes.arena],
    doc="Gold, bounties, income and the shop.",
)

__all__ = ["economy", "Bounty", "Items", "Wallet", "ShopPanel", "buy_item", "stat_lines"]
