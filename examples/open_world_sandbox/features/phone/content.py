"""Named places and phone contacts."""

from parallax import EntityRef, Localized, content, field
from parallax.story import DialogueRef


@content("place")
class PlaceDef:
    """A destination on the map. `at` is resolved with `ctx.world.placement`, so it needn't be loaded."""

    label: Localized = field()
    glyph: str = field("•", doc="One character drawn on the map pin.")
    at: EntityRef = field()


@content("contact")
class ContactDef:
    """Someone in the phone. Calling them plays their `call` node."""

    name: Localized = field()
    number: str = field()
    dialogue: DialogueRef = field()
