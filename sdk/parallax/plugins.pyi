"""Plugin constructors. The plugin list in `Game(plugins=[...])` is the game's capability
list: a component type or `ctx` namespace exists only if its plugin is included.

Core (always present): rendering, UI, audio, camera, input, environment, VFX, debug."""

from typing import Callable, Literal, Sequence
from parallax import Actions, Behavior, Button, Plugin, PrefabRef
import parallax.ai
from parallax.combat import DamageModifier
from parallax.net import VisibleFn
from parallax.physics import Layers, Materials

def physics2d(*, gravity: float = -9.8, layers: type[Layers] | None = None,
              materials: type[Materials] | None = None, interpolate: bool = True) -> Plugin:
    """Rapier 2D. Gravity in m/s² along y — exactly what is applied. `interpolate`: draw
    physics-driven entities between fixed steps (presentation only)."""

def physics3d(*, gravity: float = -9.8, layers: type[Layers] | None = None,
              materials: type[Materials] | None = None, interpolate: bool = True) -> Plugin:
    """Rapier 3D (joints, force fields, materials, ragdolls). Gravity in m/s² along y —
    exactly what is applied."""

def destruction() -> Plugin:
    """Breakables, fracture, impact damage (parallax.destruction). Needs physics3d."""

def combat(*, modifiers: Sequence[DamageModifier] = (), min_damage: float = 0) -> Plugin:
    """Health, damage pipeline, status effects, sides, pooled projectiles (`ctx.combat.fire`).
    Modifiers run in list order on every hit; `min_damage` is the least a hit that got
    through armor deals."""
def characters() -> Plugin:
    """Walking bodies (parallax.characters): the Character controller for players and NPCs
    (slopes, steps, ground snap, coyote time, stances, traversal, swimming, carrying) and
    Seats to ride in. Needs physics3d."""
def viewmodel() -> Plugin:
    """First-person arms and held items on their own view layer (parallax.viewmodel)."""
def vehicles() -> Plugin:
    """Cars, tracked vehicles, boats and planes (parallax.vehicles)."""
def nav(*, agent_radius: float = 0.4, cell_size: float = 0.25) -> Plugin:
    """Pathfinding agents over layered walkable surfaces in 3D scenes (parallax.nav,
    `ctx.nav`). `agent_radius`: meters, the radius `ctx.nav` queries plan for (agents use
    their own); `cell_size`: meters, the nav grid's cell edge (smaller is finer and slower)."""
def grid() -> Plugin:
    """Boards and tile maps (parallax.grid)."""
def story() -> Plugin:
    """Facts, quests and dialogue (parallax.story, `ctx.story`), with the built-in
    DialoguePanel."""
def save() -> Plugin:
    """Save slots and checkpoints (`ctx.save`). Nothing saves on its own: the game calls
    `ctx.save.save(slot)` when it wants to."""
def terrain() -> Plugin:
    """Heightfield ground from the scene's "terrain" block (parallax.terrain)."""
def foliage() -> Plugin:
    """Scattered trees, bushes, plants and rocks, and grass, from the scene's "foliage" block (parallax.foliage)."""
def wind() -> Plugin:
    """One wind field for the scene, from its "wind" block; sways foliage and grass (parallax.wind)."""
def voxels(*, chunk_size: int = 16, save_edits: bool = True) -> Plugin:
    """Block worlds (and smooth dig-anywhere worlds). `save_edits`: player edits are saved
    as a diff against the generated world."""
def procgen() -> Plugin:
    """Geometry from data (parallax.procgen): splines swept into roads, tracks, rails and
    pipes; structures from floor plans; seeded dungeons with prop kits."""
def city() -> Plugin:
    """A procedural city from the scene's "city" block: streets, blocks, buildings, landmarks,
    traffic and pedestrians, streamed by chunk with levels of detail (parallax.city, `ctx.city`)."""

def local_players(
    *,
    seats: int,
    player_prefab: PrefabRef,
    controls: Sequence[type[Actions]] | Literal["gamepads"],
    camera_prefab: PrefabRef | None = None,
    split_screen: Literal["none", "vertical", "horizontal", "grid"] = "vertical",
) -> Plugin:
    """Local multiplayer on one device. Each seat i gets an entity from `player_prefab`
    at a `PlayerStart(seat=i)` placement, owned by `ctx.players[i]`, reading
    `controls[i]` (or gamepad i with "gamepads"). With split screen each seat gets a
    camera from `camera_prefab` following its entity, in its own viewport;
    `ctx.camera.main` and `PlayerPanel` panels resolve to the current seat."""

def net(
    *,
    max_players: int,
    player_prefab: PrefabRef,
    tick_rate: int = 30,
    mode: Literal["dedicated", "host"] = "dedicated",
    visible: VisibleFn | None = None,
    predict: Sequence[type[Behavior]] = (),
    interpolation: float | None = None,
    rejoin: float = 20,
    rewind: float = 0.4,
) -> Plugin:
    """Server-authoritative online multiplayer (see parallax.net). Player entities spawn
    at PlayerStart placements.

    predict: behaviors that also run on the owning player's client, on that player's own
        entities only, so their movement answers at once (the server's result corrects
        it smoothly). List the ones that steer the player; never ones that spawn or score.
    interpolation: seconds other entities are shown in the past; None adapts to the
        tick rate and the measured jitter (about two ticks).
    rejoin: seconds a dropped player's seat and entity wait for them (0: they leave at once).
    rewind: the most seconds lag compensation (`ctx.net.raycast`) rewinds."""

def hud(*, units: Literal["metric", "imperial"] = "metric") -> Plugin:
    """The HUD kit (parallax.hud): minimap, compass, crosshair, nameplates, markers and pings,
    stat bars, ability bar, combo, key hints, awareness, screen juice. Widgets appear from
    the components on the player and in the world.
    units: how marker, compass and ping distances read — "metric": "640 m", then "1.2 km"
    from 1000 m; "imperial": "850 ft", then "0.2 mi" from 1000 ft."""

def interaction(*, action: Button) -> Plugin:
    """Interactable / Interactor focus and prompts, and doors (parallax.interaction).
    `action` is the button that interacts (Controls.interact)."""

def ai(*, tasks: Sequence[Callable[..., object]] = (), trees: Sequence[object] = (),
       director: parallax.ai.Director | None = None, fog_cell: float = 2.0) -> Plugin:
    """Behavior trees, perception, squads, tactical queries, RTS orders, flocks, a combat
    director and fog of war (parallax.ai). `tasks`: the Python leaf functions trees may run;
    `trees`: trees built in code (content/behavior_tree/*.json are found by themselves)."""

def economy() -> Plugin:
    """Wallets and pools, inventories, shops, loot, upgrade drafts and pickups (parallax.economy)."""

def spawning() -> Plugin:
    """Wave spawners: count or budget waves under a `max_alive` cap (parallax.spawning)."""

def cinematics(*, skip: Button | None = None, advance: Button | None = None) -> Plugin:
    """Data-authored cutscenes (parallax.cinematics). `skip` ends a skippable one;
    `advance` moves past a dialogue line waiting for the player (the cinematic panel's
    Continue button always does)."""

def water() -> Plugin:
    """Oceans, lakes, pools and rivers with waves, buoyancy, currents and swimming
    (parallax.water). List it after physics3d when bodies float."""

def weather() -> Plugin:
    """Rain, snow, hail, fog, cloud, wind and lightning blended between presets by a director
    (parallax.weather); the scene's environment "weather" key sets it."""

def softbody() -> Plugin:
    """Cloth and soft bodies (parallax.softbody): capes, flags, curtains, jelly, slime.
    List it after physics3d (it reads its gravity and colliders)."""

def screens() -> Plugin:
    """@ui panels on in-world screens (parallax.screens)."""

def voice(*, mode: Literal["push_to_talk", "voice_activity", "open"] = "push_to_talk",
          talk: Button | None = None, threshold: float = 0.08, hangover: float = 0.3,
          near: float = 2, far: float = 25, positional: bool = True) -> Plugin:
    """Proximity voice chat between net players (parallax.voice). `talk`: the push-to-talk
    button (required for that mode). `threshold`: microphone level 0..1 voice activity
    sends above; `hangover`: seconds it keeps sending after. Voices are full within `near`
    meters of the listener's camera and silent from `far`; `positional=False` hears
    everyone everywhere (radio)."""

def chat(*, max_length: int = 200, per_second: float = 1, burst: int = 5, history: int = 50,
         filter: Callable[..., str | None] | None = None) -> Plugin:
    """Text chat (parallax.chat). `filter(ctx, player, text)` returns the text to show
    (masked if you like) or None to refuse it; it runs on the authority."""

def payments() -> Plugin:
    """In-game purchases through the host page or app (parallax.payments); products are
    content/product/*.json."""
