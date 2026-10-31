"""Sides and damage kinds. Data files name these by id ("hostile", "fire"); the checker resolves them."""

from parallax import tag

Hostile = tag("hostile")
Ally = tag("ally")
Boss = tag("boss")
Telegraph = tag("telegraph")

Physical = tag("physical")
Fire = tag("fire")
Frost = tag("frost")
Arcane = tag("arcane")
