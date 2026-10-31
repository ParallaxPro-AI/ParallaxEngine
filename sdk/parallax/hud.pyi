"""HUD kit (plugins.hud()): minimap, compass, crosshair, nameplates and world health bars,
objective markers and pings, stat bars, ability bar, combo counter, key hints, awareness
meters and damage arcs, and screen juice (hurt flash, low-health vignette, hit-stop,
shake, eased slow motion).

Everything a HUD shows is data:
  - viewer components go on the entity a seat plays (the player prefab): Minimap, Compass,
    Crosshair, StatBars, Abilities, Combo, KeyHints, HurtFeedback;
  - world components go on whatever should appear: MapIcon, MapFeature, Nameplate,
    Awareness — plus core `Marker` and combat's `HealthBar`, which the HUD draws.

The panels that draw them are built in (MinimapPanel, CrosshairPanel, …): each opens by
itself exactly while it has something to show, one copy per seat. There is no HUD list to
keep and nothing to toggle — add `Minimap()` to the player and the map appears.

Which entity a seat plays: with local_players / net, `player.entity`; in a one-player game,
the only entity carrying that component, or the one the camera follows. Anything else is an
error with the fix (PP3556).

Restyle a panel by subclassing it with your own markup — it binds the same state keys
(listed on each class), and the built-in steps aside while a subclass is declared:

    @ui("big_map", html="ui/big_map.html")
    class BigMap(MinimapPanel): ...

The player's accessibility settings (Settings.reduced_motion, high_contrast, text_scale,
colorblind) apply to every HUD panel's default look.

Text on engine components (Nameplate.text, Marker / MapIcon labels, stat bar and ability
labels, ping labels, Interactable.prompt) is source-language text or a locale key: each
shows as the player's language (Settings.language) has that key in locale/<lang>.json,
else as written.

Marker (core) and combat's HealthBar are drawn only by this plugin: without hud() in the
game they show nothing, and `parallax check` warns (PP2553).
"""

from typing import Literal
from parallax import (
    Color, Ease, EngineComponent, Entity, Handle, Player, PlayerPanel, Vec2, Vec3, component, field, record,
)

Icon = Literal["dot", "arrow", "square", "diamond", "triangle", "star", "cross", "skull", "flag", "pin", "ring"]
PingKind = Literal["look", "go", "enemy", "loot", "help"]


# ─────────────────────────────────────────────────────────────────────────────
# Viewer components (on the player)
# ─────────────────────────────────────────────────────────────────────────────

@component("minimap")
class Minimap(EngineComponent):
    """A map of the scene around this entity. The base map is derived from the scene: static
    Shapes and non-trigger Colliders (things with a Rigidbody, Character, Vehicle or NavAgent
    move and are left out), the terrain, and MapFeature placements. MapIcon entities are drawn
    on it; set `range` to zoom."""
    range: float = field(40, min=1, unit="m", doc="Center to rim.")
    rotate: bool = field(True, doc="Turn with this entity's heading (player-up); False: north-up.")
    shape: Literal["circle", "square"] = field("circle")
    route: list[Vec3] = field([], doc="A route line in world points (e.g. ctx.nav.path(...)); empty: none.")
    shown: bool = field(True)

@component("compass")
class Compass(EngineComponent):
    """A heading strip (the camera's heading in 3D) with Marker and MapIcon(compass=True) entities on it."""
    fov: float = field(180, min=30, max=360, doc="Degrees of heading the strip spans.")
    markers: bool = field(True)
    shown: bool = field(True)

@component("crosshair")
class Crosshair(EngineComponent):
    """The seat's crosshair. Weapon code sets `spread`, `reload` and `style` ("scope" while
    aiming down a scope). Damage this entity deals (combat's Damaged) flashes a hit marker;
    a kill (Died) flashes the kill marker."""
    style: Literal["none", "dot", "cross", "circle", "scope"] = field("cross")
    spread: float = field(0, min=0, max=45, doc="Half-angle in degrees of the current aim cone.")
    reload: float | None = field(None, doc="0..1 while reloading.")
    color: Color = field(Color(1, 1, 1))
    hit_markers: bool = field(True)

@record
class StatBar:
    """One bar: `value` (and `max`) are `"<component>.<field>"` paths on the same entity."""
    value: str
    label: str = field("")
    max: str | None = field(None, doc="None: `value` is already 0..1.")
    color: Color = field(Color.hex("#e04848"))
    numbers: bool = field(True, doc='Show "value / max".')
    low: float = field(0.25, min=0, max=1, doc="Below this fraction the bar pulses.")

@component("stat_bars")
class StatBars(EngineComponent):
    """HUD bars bound to this entity's fields:
    {"stat_bars": {"bars": [{"label": "HP", "value": "health.current", "max": "health.max"},
                            {"label": "Stamina", "value": "stamina.value", "max": "stamina.max", "color": "#3fb0ff"}]}}"""
    bars: list[StatBar] = field([])

@record
class AbilitySlot:
    id: str
    cooldown: float = field(min=0, unit="s", doc="Seconds to regain one charge.")
    label: str = field("")
    icon: str = field("", doc='A short glyph or letter shown in the slot ("⚡", "Q").')
    image: str | None = field(None, doc='An image file shown instead of `icon`: a project path ("assets/ui/dash.png").')
    charges: int = field(1, min=1)
    action: str | None = field(None, doc='"<ActionSet>.<action>" whose key the slot shows ("Controls.dash").')

@component("abilities")
class Abilities(EngineComponent):
    """Cooldowns and charges, kept by the engine in game time (saved with the entity). The
    seat's own show on the ability bar; enemies may have them too.

        if ctx.input.pressed(Controls.dash) and self.entity.get(Abilities).use("dash"):
            ...dash..."""
    slots: list[AbilitySlot] = field([])
    charges: dict[str, int] = field({}, doc="Charges ready per slot while short of full (kept by the engine).")
    left: dict[str, float] = field({}, doc="Seconds to the next charge per slot (kept by the engine).")
    def use(self, slot: str) -> bool:
        """Spend a charge and start its cooldown; False (nothing spent) when none is ready."""
    def ready(self, slot: str) -> bool: ...
    def available(self, slot: str) -> int:
        """Charges ready now."""
    def remaining(self, slot: str) -> float:
        """Seconds until it can be used again (0 when ready)."""
    def refill(self, slot: str | None = None) -> None:
        """All charges back (one slot, or every slot)."""

@component("combo")
class Combo(EngineComponent):
    """A combo counter: each hit within `window` seconds of the last adds one. The seat's own
    shows on the HUD from two hits on."""
    window: float = field(2, min=0.05, unit="s")
    count: int = field(0, min=0)
    best: int = field(0, min=0)
    left: float = field(0, min=0, unit="s", doc="Until the combo breaks.")
    from_damage: bool = field(True, doc="Every Damaged this entity is the source of counts as a hit.")
    def hit(self, n: int = 1) -> None: ...
    def drop(self) -> None:
        """Break the combo now (got hit, missed)."""

@component("key_hints")
class KeyHints(EngineComponent):
    """Which actions' keys to show, as the player reads them on their current device
    (keyboard keys, gamepad buttons, touch buttons), remaps included. Hints of action sets
    that aren't live (active_when, scenes) are hidden."""
    actions: list[str] = field([], doc='"<ActionSet>.<action>" names, in order ("Controls.jump").')
    shown: bool = field(True)

@component("hurt_feedback")
class HurtFeedback(EngineComponent):
    """What taking damage (combat's Damaged) feels like for the seat playing this entity.
    Reduced motion (Settings) turns the shake off and softens the flash."""
    flash: float = field(0.6, min=0, max=1, doc="Peak flash opacity; a hit of a quarter of max health or more flashes fully.")
    shake: float = field(0.3, min=0, doc="Camera shake at a full-strength hit.")
    hitstop: float = field(0, min=0, max=0.5, unit="s", doc="Hit-stop on every hit.")
    direction: bool = field(True, doc="An arc pointing at whoever hit this entity.")
    low_health: float = field(0.3, min=0, max=1, doc="Below this health fraction the screen edge pulses (0: never).")
    color: Color = field(Color.hex("#d01818"))
    noise_cues: bool = field(False, doc="Arcs toward recent noises this entity could hear (ai()'s ctx.ai.noise: gunshots, footsteps).")


# ─────────────────────────────────────────────────────────────────────────────
# World components (on anything)
# ─────────────────────────────────────────────────────────────────────────────

@component("map_icon")
class MapIcon(EngineComponent):
    icon: Icon = field("dot")
    color: Color = field(Color(1, 1, 1))
    size: float = field(1, min=0.1, max=8)
    rotate: bool = field(False, doc="Turn with the entity's heading (vehicles, other players).")
    edge: bool = field(False, doc="Stay on the map's rim when out of range (objectives).")
    compass: bool = field(False, doc="Also show on the compass strip.")
    label: str | None = field(None)
    shown: bool = field(True)

@component("map_feature")
class MapFeature(EngineComponent):
    """How a placement draws on the base map. Without one, static Shapes and Colliders draw as
    floor (0.5 m tall or less) or solid."""
    kind: Literal["solid", "floor", "road", "water", "path", "hidden"] = field("solid")
    color: Color | None = field(None)
    order: int = field(0, doc="path: nodes are joined in this order.")
    width: float = field(4, min=0.1, unit="m", doc="path / road stroke width.")
    loop: bool = field(False, doc="path: join the last node back to the first.")

@component("nameplate")
class Nameplate(EngineComponent):
    """A name (and the entity's Health) over it, for every seat within `range`. combat's
    HealthBar alone draws a bar without a name."""
    text: str | None = field(None, doc="None: the entity's name.")
    offset: Vec3 = field(Vec3(0, 2.2, 0))
    range: float = field(30, min=0, unit="m")
    health: bool = field(True)
    color: Color | None = field(None, doc="None: ally / enemy / neutral by Side.")
    shown: bool = field(True)

@component("awareness")
class Awareness(EngineComponent):
    """A stealth meter over an NPC: "?" filling up to "!" at 1; off screen, an edge arrow.
    Set `level` from the NPC's perception."""
    level: float = field(0, min=0, max=1)
    offset: Vec3 = field(Vec3(0, 2.4, 0))
    shown: bool = field(True)


# ─────────────────────────────────────────────────────────────────────────────
# ctx.hud
# ─────────────────────────────────────────────────────────────────────────────

class HudApi:
    def ping(self, at: Vec3 | Vec2 | Entity, *, kind: PingKind = "look", seconds: float = 6,
             label: str = "", to: Player | None = None) -> None:
        """A marker at a point or on an entity, on screen (pinned to the edge off screen) and on
        the minimap, for `seconds`. `to=None`: every local seat."""
    def hit_marker(self, *, kill: bool = False, to: Player | None = None) -> None:
        """Flash the crosshair's hit (or kill) marker. Damage dealt by a Crosshair entity does this by itself."""
    def screen_flash(self, color: Color = ..., *, strength: float = 0.5, seconds: float = 0.3,
                     ease: Ease = "out_quad", to: Player | None = None) -> None:
        """A full-screen flash (pickups, explosions): `color` at `strength` opacity (0..1) at
        once, fading out over `seconds` as 1 − ease(t) — "linear" fades evenly, "in_cubic" holds
        then drops, "out_quad" (default) falls fast with a soft tail."""
    def slow_motion(self, scale: float, seconds: float, *, ease_in: float = 0.15, ease_out: float = 0.3) -> Handle:
        """Ease time.scale down to `scale` (0..1), hold, and ease back, over `seconds` of real time.
        A new call replaces the one under way; cancel the handle to end it at once."""


# ─────────────────────────────────────────────────────────────────────────────
# Built-in panels (subclass to restyle; state keys listed)
# ─────────────────────────────────────────────────────────────────────────────

class MinimapPanel(PlayerPanel):
    """{shown, round, base, base_left, base_top, base_width, base_height, turn, player_turn,
    icons: [{icon, glyph, x, y, color, size, turn, label, edge}], has_route, route, range, a11y}"""
class CompassPanel(PlayerPanel):
    """{shown, heading, ticks: [{label, x, major}], marks: [{glyph, color, x, distance, label}], a11y}

    `distance` (here and on MarkersPanel) is text in `hud(units=)`: "640 m", "1.2 km"."""
class CrosshairPanel(PlayerPanel):
    """{shown, dot, cross, circle, scope, gap, color, hit, kill, reloading, reload, a11y}"""
class NameplatesPanel(PlayerPanel):
    """{shown, plates: [{x, y, text, named, health, fill, color, low, bar_width, bar_height,
    bar_background, bar_border}], a11y} — the bar_* keys are the HealthBar's own look as CSS, or None."""
class MarkersPanel(PlayerPanel):
    """{shown, markers: [{x, y, on_screen, turn, icon, glyph, label, distance, color, ping}], a11y}"""
class StatBarsPanel(PlayerPanel):
    """{shown, bars: [{label, text, fill, color, low, numbers}], a11y}"""
class AbilityBarPanel(PlayerPanel):
    """{shown, slots: [{id, label, icon, keys: [{text, code, device, pad, touch}], ready, charges,
    max_charges, show_charges, fill, seconds}], a11y}"""
class ComboPanel(PlayerPanel):
    """{shown, count, best, fill, a11y}"""
class KeyHintsPanel(PlayerPanel):
    """{shown, device, hints: [{label, action, keys: [{text, code, device, pad, touch}]}], a11y}"""
class AwarenessPanel(PlayerPanel):
    """{shown, meters: [{x, y, fill, alerted, on_screen, turn}], hits: [{turn, opacity}],
    sounds: [{turn, opacity, kind}], a11y}"""
class ScreenEffectsPanel(PlayerPanel):
    """{shown, flash, flash_color, vignette, vignette_color, a11y}

    `a11y` on every panel: {contrast: bool, calm: bool (reduced motion), font: "120%"}.
    Positions are CSS percentages of the seat's view; sizes and colours are CSS strings."""
