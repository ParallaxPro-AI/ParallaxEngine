"""Per-entity data for the people of Sundermere."""

from parallax import component, field, tag
from parallax.story import DialogueRef

Npc = tag("npc")
Merchant = tag("merchant")


@component("talkable")
class Talkable:
    """Interact within `reach` to start this conversation."""

    dialogue: DialogueRef = field()
    node: str = field("start")
    reach: float = field(4.5, min=0.5, unit="m")
