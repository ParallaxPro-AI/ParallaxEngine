"""Interaction (plugins.interaction(action=Controls.interact)): "[E] Open" prompts.

An `Interactable` is something that can be used; an `Interactor` (on the player) uses
things. Every frame, before the game's systems, each interactor's `focus` is derived —
"proximity": the nearest enabled interactable in reach inside its facing cone; "look": the
one closest to the camera's center, with line of sight (physics3d). Pressing the action (or
holding it for the interactable's `hold` seconds) emits `Interacted` to the interactable's
behaviors and to systems. The built-in prompt panel shows the focus with the action's key as
the player reads it on their current device, remaps included, and a ring while holding.

    @behavior("chest")
    class Chest(Behavior):
        @on(Interacted)
        def opened(self, ctx, e: Interacted):
            ctx.ui.toast("Found 10 gold")

The key is read for the interactor's seat, muted while a modal panel is open. Nothing
toggles: an interactable that is disabled, out of reach or destroyed simply loses focus.

Doors: a `Door` opens, closes and locks, and swings / slides its transform or drives a
Model joint, moved each frame before the game's systems. An Interactable door toggles when
used (`toggle_on_interact`). A locked door opens for someone carrying its `key` (an economy
item in their Inventory, used up with `consume_key`), or after `unlock()` from code.

    gate.get(Door).open(by=player)        # False (DoorBlocked) without its key
"""

from typing import Literal
from parallax import ContentRef, EngineComponent, Entity, PlayerPanel, Vec3, component, event, field
from parallax.economy import ItemDef

@component("interactable")
class Interactable(EngineComponent):
    prompt: str = field("Interact", doc='The verb after the key ("Open", "Talk"), or a locale key: shown in the player\'s language when locale/<lang>.json has it.')
    range: float = field(2.5, min=0, unit="m", doc="Horizontal reach from the interactor.")
    hold: float = field(0, min=0, unit="s", doc="Seconds to hold the action; 0: a press.")
    enabled: bool = field(True)
    once: bool = field(False, doc="Disable itself after the first use.")
    offset: Vec3 = field(Vec3(0, 1, 0), doc="Where the prompt sits and what a look-mode interactor aims at.")

@component("interactor")
class Interactor(EngineComponent):
    mode: Literal["proximity", "look"] = field("proximity")
    range: float = field(3, min=0, unit="m")
    angle: float | None = field(None, doc="Degrees: proximity — half-angle of the facing cone (180: any side); "
                                          "look — from the view's center. None: 75 / 12 (2D: 180).")
    line_of_sight: bool = field(True, doc="3D: something solid in between blocks the focus (needs physics3d).")
    focus: Entity | None = field(None, doc="The interactable in focus now (kept by the engine).")
    progress: float = field(0, min=0, max=1, doc="0..1 of a hold under way (kept by the engine).")

@event("interacted", target="entity")
class Interacted:
    entity: Entity
    """The interactable."""
    source: Entity
    """The interactor."""

@component("door")
class Door(EngineComponent):
    mode: Literal["swing", "slide", "joint"] = field("swing")
    open_value: float = field(90, doc="swing: degrees about +y; joint: the joint's open value.")
    hinge: Vec3 = field(Vec3(0, 0, 0), doc="swing: the local point it turns about.")
    slide: Vec3 = field(Vec3(0, 0, 0), doc="slide: the local offset when fully open.")
    joint: str | None = field(None, doc="joint: the Model joint it drives.")
    seconds: float = field(0.6, min=0, unit="s")
    auto_close: float | None = field(None, min=0, unit="s")
    locked: bool = field(False)
    key: ContentRef[ItemDef] | None = field(None, doc="An item (economy()) carried in the user's Inventory.")
    consume_key: bool = field(False)
    toggle_on_interact: bool = field(True, doc="With an Interactable: using the door toggles it (its key unlocks it), as toggle(by=user).")
    wants_open: bool = field(False, doc="The wanted state (open() / close() set it).")
    amount: float = field(0, min=0, max=1, doc="0 shut … 1 open (kept by the engine).")
    close_at: float = field(-1, doc="Kept by the engine.")
    rest_position: Vec3 | None = field(None, doc="The shut pose (kept by the engine).")
    rest_rotation: Vec3 | None = field(None, doc="Kept by the engine.")

    def open(self, *, by: Entity | None = None) -> bool:
        """Locked: opens only when `by` carries the key (used up with consume_key); else
        DoorBlocked and False."""
    def close(self) -> None: ...
    def toggle(self, *, by: Entity | None = None) -> bool: ...
    def lock(self) -> None: ...
    def unlock(self, *, by: Entity | None = None) -> bool:
        """`by` None: unlock from code; else with `by`'s key."""
    @property
    def is_open(self) -> bool: ...
    @property
    def is_closed(self) -> bool: ...

@event("door_opened", target="entity")
class DoorOpened:
    entity: Entity

@event("door_closed", target="entity")
class DoorClosed:
    entity: Entity

@event("door_blocked", target="entity")
class DoorBlocked:
    entity: Entity
    source: Entity | None
    """Who tried it without the key (None: from code)."""
    key: ContentRef[ItemDef] | None

class InteractPromptPanel(PlayerPanel):
    """{shown, text, keys: [{text, code, device, pad, touch}], hold, fill, x, y, anchored, a11y}

    Built-in prompt, open while some interactor has a focus — anchored: at the interactable
    on screen, else bottom center. Subclass it with your own `html=` to restyle it (the
    built-in steps aside while a subclass is registered); `parallax check` reads these keys."""
