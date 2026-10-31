"""Tags shared by every feature."""

from parallax import tag

Player = tag("player")
Creature = tag("creature")
"""Anything the player's swing can hit."""
Hostile = tag("hostile")
Usable = tag("usable")
"""Entities the use action reaches directly (graves); blocks are reached through their cell."""
Workbench = tag("workbench")
"""Crafting station; recipes that need one work within `Rules.station_range` of it."""
