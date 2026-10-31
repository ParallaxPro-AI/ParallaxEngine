"""Walk-in buildings: building shells with interior volumes, and asking which one a point is in.

A leaf feature that knows nothing about guns, cars or jobs.
"""

from parallax import Feature

from features.interiors.components import InteriorZone
from features.interiors.queries import interior_at

interiors = Feature(
    "interiors",
    doc="Building shells (safehouse, supply store, garage) and the interior volumes inside them.",
)

__all__ = ["InteriorZone", "interior_at", "interiors"]
