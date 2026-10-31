"""What food exists, what each station does with it, what customers order, the three
kitchens (content), how a service is scored and what it sounds like (config). The whole
recipe chain is data; adding a dish is a JSON edit."""

from typing import Literal

from parallax import (
    Color, ContentRef, Localized, ModelRef, SceneRef, SoundRef, Vec3, config, content, field, record,
)


@record
class Cue:
    """A sound and the volume the template's cue map plays it at."""

    sound: SoundRef
    volume: float = field(0.5)


@content("item")
class Item:
    """Anything a chef can carry: a raw ingredient, a chopped one, a finished dish."""

    name: Localized
    stage: int = field(1, doc="The step of the recipe it stands for, shown as 'Step n' (0: a mistake).")
    task: Localized = field(doc="What to do next while holding it.")
    hint: Localized = field(doc="Where to do it.")
    carry_shape: Literal["sphere", "box", "cylinder"] = field("box")
    carry_color: Color = field(Color.WHITE)
    carry_size: Vec3 = field(Vec3.ONE * 0.3, unit="m")


@record
class Step:
    """One thing a chef can do at a station. `takes` is what must be in their hands
    (None = empty-handed); exactly one outcome applies."""

    prompt: Localized
    takes: ContentRef[Item] | None = field(None)
    takes_anything: bool = field(False)
    gives: ContentRef[Item] | None = field(None)
    cook_seconds: float = field(0, unit="s")
    burn_seconds: float = field(0, unit="s")
    to_plate: bool = field(False)
    requires_plate: list[ContentRef[Item]] = field([])
    deliver: bool = field(False)
    discard: bool = field(False)
    feedback: Localized | None = field(None)
    cue: Cue | None = field(None)


@content("station")
class StationKind:
    """A kind of station and every step it offers. A station whose model has a door
    names the joint in `opens`: using it swings the door open for `opens_for` seconds.
    `label` and `color` are its pin in the wayfinding overlay."""

    label: Localized
    color: Color
    steps: list[Step]
    opens: str | None = field(None, doc="A joint of the station's Model.")
    opens_for: float = field(1.1, unit="s")


@content("dish")
class Dish:
    """A menu entry a customer can order."""

    name: Localized
    item: ContentRef[Item] = field(doc="What has to be served at the window.")
    points: int = field(10)
    ingredients: list[ContentRef[Item]] = field([], doc="Shown on the ticket as coloured dots.")
    method: Localized = field(doc="Shown on the ticket: 'chop · plate'.")


@content("kitchen")
class Kitchen:
    """One kitchen of the campaign: a scene, a clock, a target and the menu it serves."""

    name: Localized
    brief: Localized
    scene: SceneRef
    seconds: float = field(90, unit="s")
    target: int = field(40, doc="Team score needed by the end, carried over from earlier kitchens.")
    order_interval: float = field(6, unit="s")
    menu: list[ContentRef[Dish]] = field([])


@config("service")
class ServiceRules:
    """The campaign and how a service is scored."""

    kitchens: list[ContentRef[Kitchen]]
    burnt: ContentRef[Item] = field(doc="What a pot left on the heat becomes.")
    chef_models: list[ModelRef] = field([], doc="Each seat's chef model.")
    max_orders: int = field(5)
    order_lifetime: float = field(22, unit="s")
    streak_bonus: int = field(2, doc="Extra points per dish in the current streak.")
    streak_cap: int = field(6)
    speed_bonus: int = field(8, doc="Up to this much for serving a fresh ticket.")
    wrong_dish_penalty: int = field(5)
    burn_penalty: int = field(3)
    clock_warning: float = field(25, unit="s", doc="The clock turns red below this.")
    guide_range: float = field(40, unit="m", doc="Stations further than this get no pin.")


@config("sounds")
class KitchenSounds:
    """The kitchen's cue map (the template's data/audio/kitchen); station steps name their
    own cues in content."""

    order_new: Cue
    pickup: Cue
    cook_ready: Cue
    burn: Cue
    wrong: Cue
    delivery: Cue
    level_clear: Cue
    victory: Cue
    game_over: Cue
