"""Characters plugin: one Character component for anything that walks (players, NPCs).
Kinematic controller on Rapier; handles slopes, steps, ground snapping, coyote time.

The humanoid tier is data on the same component. Each ability is a record field that is
None (off) until the prefab gives it; `{}` turns it on with its defaults:

    "character": {"walk_speed": 4, "run_speed": 7,
                  "stances": {"crouch_height": 1.2, "prone": true},
                  "traversal": {"climb_height": 2.2},
                  "swim": {}, "skydive": {}, "parachute": {}, "carry": {}}

What the character is doing is `motion` (derived each step, never set); its posture is
`stance`. `move()` steers in every motion, `jump()` is the one "go" verb: it jumps, vaults
or climbs a ledge ahead (traversal), opens the parachute in free fall, and climbs out of
water onto a ledge. `run=True` is the sprint (never while crouched, prone or carrying).

Animation. With an Animator on the entity and `animate` True, the character sets the graph
params the Animator declares, by these names (undeclared names are skipped; a declared one
of the wrong kind is PP3176):

    numbers   speed (m/s along the ground), vertical_speed (m/s, up +), stance (0 stand,
              1 crouch, 2 prone), forward_speed / strafe_speed (m/s along and across the
              facing: back and left are negative — a 2D blend's "params"), direction
              (degrees from the facing to the travel: 0 ahead, 90 right, ±180 back),
              turn_rate (deg/s, right +: turn-in-place states)
    booleans  grounded, running, crouched, prone, swimming, traversing, seated, falling
              (free fall), gliding, holding, carrying
    triggers  jumped, landed, vaulted, climbed

Locomotion without a graph. When the Animator's base layer has no states (no "layers", or
a first layer without "states") and `locomotion` is "auto" (the default), the character
plays clips on it by itself, picked from the model's own clip names — so any rigged glTF
with the usual names (Mixamo's "Idle", "Walking", "Running", "Left Strafe Walking",
"Walking Backwards", "Jumping", "Falling Idle", "Hard Landing", "Crouched Walking",
"Swimming", "Sitting Idle"…; also "idle" / "walk" / "run", "Armature|Walk") animates with
no graph at all:

    "animator": {}            # that's all: idle / walk / run / sprint, strafes, turns, air

- gaits: idle, walk, run (from midway between walk_speed and run_speed), sprint (1.2 ×
  run_speed), with hysteresis so a speed near a boundary doesn't flicker between clips
- direction: forward, back, left or right of the facing, so strafing plays strafes
- turning on the spot plays a turn clip; jumping, falling and hard landings their clips;
  crouch / prone gaits, swimming, vaulting, climbing, seats, free fall and the parachute too
- playback speed follows the ground speed (the clip's own root travel, or a gait's
  typical stride for in-place clips), so feet don't slide
- each state falls back to one every rig has (a back walk to the walk, a sprint to the
  run), and the project's authored clips count too (`clips/walk_cycle` is a walk)

`clips` picks a clip for a state by hand ({"walk": "Walk_Rifle", "idle":
"models/anims#Idle"}). Game code keeps the base layer whenever it plays
something else there (`play_once("attack")`, `play("dance")`): locomotion waits until the
layer is back on one of its clips (a one-shot returns by itself) or `stop()`ped. Upper-body
actions belong on a masked layer and never interrupt it. `locomotion = "off"` leaves the
Animator to game code.

With the Animator's `root_motion: "character"` the clip's root travel moves the character
(through the controller: walls, steps and gravity still apply) instead of `move()`'s speed;
`move()` still steers, faces and sets `speed` to the speed asked for.

Cameras. The camera rig owns the view (`Camera(rig="first_person" | "orbit" | "follow")`);
a first-person rig following a character sits at its `eye`, which lowers with the stance.
"""

from typing import Literal
from parallax import Color, EngineComponent, Entity, PrefabRef, Vec2, Vec3, component, event, field, record

Motion = Literal["ground", "air", "swim", "traverse", "free_fall", "glide", "seated", "riding", "carried", "ragdoll"]
"""ground / air: walking and jumping (with weather(), ground traction in the open follows its
friction: wet ground and settled snow are slippery). swim: in water (needs `swim` and a
water plugin; going in splashes).
traverse: vaulting or climbing (code doesn't steer it). free_fall / glide: skydiving, the
parachute open. seated: in a Seat. riding: in a vehicle's Seat. carried: on another character. ragdoll: limp or
recovering (physics3d `go_limp` / `recover`): it doesn't move or steer by itself."""

Stance = Literal["stand", "crouch", "prone"]

@record
class Stances:
    """Crouch (and optionally prone). The capsule shrinks to the stance's height with the
    feet where they are; standing back up needs the headroom."""
    crouch_height: float = field(1.2, min=0, unit="m")
    crouch_speed: float = field(2, min=0, unit="m/s", doc="Top speed crouched.")
    prone: bool = field(False, doc="Whether lying prone is allowed.")
    prone_height: float = field(0.8, min=0, unit="m")
    prone_speed: float = field(0.8, min=0, unit="m/s")

@record
class Traversal:
    """`jump()` facing a ledge vaults over it or climbs onto it instead of jumping. A ledge is
    a wall within `reach` of the capsule whose top is above `step_height` and has room for
    the standing capsule on it. Thin and low (≤ vault_height, ≤ vault_depth deep): vault over
    to the floor beyond. Otherwise, up to climb_height: climb onto the top."""
    vault_height: float = field(1.1, min=0, unit="m")
    vault_depth: float = field(0.9, min=0, unit="m")
    climb_height: float = field(2.4, min=0, unit="m")
    reach: float = field(0.6, min=0, unit="m", doc="How far beyond the capsule a ledge is found.")
    vault_time: float = field(0.45, min=0.05, unit="s")
    climb_time: float = field(0.9, min=0.05, unit="s", doc="For a climb of climb_height; lower climbs are quicker.")

@record
class Swimming:
    """Swimming in the water volumes of a water plugin (its `water` service): the character
    swims once the water at its feet is `enter_depth` deep, floats with the surface
    `float_depth` above its feet, and walks again where it is shallower than `exit_depth`.
    While swimming, `move()` takes a 3D direction (y: up and down)."""
    speed: float = field(2.8, min=0, unit="m/s")
    run_speed: float = field(4, min=0, unit="m/s")
    vertical_speed: float = field(2, min=0, unit="m/s")
    enter_depth: float = field(1.35, min=0, unit="m")
    exit_depth: float = field(0.9, min=0, unit="m")
    float_depth: float = field(1.25, min=0, unit="m")

@record
class Skydive:
    """Free fall: entered when falling faster than `enter_speed` with more than
    `enter_height` of air below. Falls at `terminal` (`dive_terminal` with run=True);
    `move()` steers sideways at up to `steer`."""
    enter_height: float = field(12, min=2, unit="m")
    enter_speed: float = field(9, min=0, unit="m/s")
    terminal: float = field(38, min=0, unit="m/s")
    dive_terminal: float = field(58, min=0, unit="m/s")
    steer: float = field(16, min=0, unit="m/s")
    acceleration: float = field(14, min=0, unit="m/s²", doc="How fast it reaches those speeds.")

@record
class Parachute:
    """Opened by `jump()` in free fall (above `min_height`), or by itself below
    `auto_height` (0: never). A glider: forward at `glide_speed` sinking at `sink`, turning
    toward `move()` at `turn_speed`; pulling back (move against the heading) flares,
    run=True dives. Needs `skydive`."""
    glide_speed: float = field(13, min=0, unit="m/s")
    sink: float = field(4.2, min=0, unit="m/s")
    turn_speed: float = field(75, min=0, unit="deg/s")
    flare_sink: float = field(1.8, min=0, unit="m/s")
    dive_sink: float = field(10, min=0, unit="m/s")
    deploy_time: float = field(0.9, min=0.05, unit="s")
    min_height: float = field(0, min=0, unit="m")
    auto_height: float = field(0, min=0, unit="m")

@record
class Carry:
    """Carrying another entity on the shoulders (`lift()`): where it rides and where
    `put_down()` sets it, in the carrier's frame (+z forward, +y up, +x right)."""
    offset: Vec3 = field(Vec3(0, 1.3, 0.1), unit="m")
    drop: Vec3 = field(Vec3(1.1, 0, 0.5), unit="m")
    speed_scale: float = field(0.55, min=0.05, max=1, doc="Ground speed multiplier while carrying.")

@component("character")
class Character(EngineComponent):
    walk_speed: float = field(4, unit="m/s", modifiable=True)
    run_speed: float = field(7, unit="m/s", modifiable=True)
    acceleration: float = field(30, unit="m/s²")
    jump_height: float = field(1.2, unit="m", modifiable=True)
    air_jumps: int = field(0, doc="Extra jumps allowed in the air.")
    air_control: float = field(0.5, min=0, max=1)
    turn_speed: float = field(720, unit="deg/s")
    face_movement: bool = field(True)
    radius: float = field(0.35, unit="m")
    height: float = field(1.8, unit="m")
    max_slope: float = field(45, unit="deg")
    step_height: float = field(0.3, unit="m")
    gravity_scale: float = field(1)
    mode: Literal["platformer2d", "topdown2d", "3d"] = field("3d")
    lock_axes: list[Literal["x", "z"]] = field([], doc='World axes the character never moves along: ["z"] keeps a 2.5D side-scroller '
                                                     'on its lane (input, knockback, sliding and moving ground alike; teleport still sets it).')
    eye_height: float | None = field(None, min=0, unit="m", doc="Standing eye height (the first-person view); stances scale it. None: 0.9 × height.")
    hold_socket: str = field("grip_r", doc="The Model socket `hold()` uses by default.")
    hold_offset: Vec3 = field(Vec3(0.25, 1.1, 0.55), unit="m", doc="Where held items sit on an entity without a Model.")
    animate: bool = field(True, doc="Set the Animator's params (see module docs).")
    locomotion: Literal["auto", "off"] = field("auto", doc="auto: with no base-layer graph, play idle / walk / run / strafe / air clips by name (see module docs).")
    clips: dict[str, str] = field({}, doc='Locomotion state → clip, over the automatic pick: idle, walk, run, sprint, walk_back, run_back, '
                                          'walk_left, walk_right, run_left, run_right, turn_left, turn_right, jump, fall, land, hard_land, '
                                          'crouch_idle, crouch_walk, prone_idle, crawl, swim_idle, swim, climb, vault, sit, free_fall, glide.')
    stances: Stances | None = field(None)
    traversal: Traversal | None = field(None)
    swim: Swimming | None = field(None)
    skydive: Skydive | None = field(None)
    parachute: Parachute | None = field(None)
    carry: Carry | None = field(None)

    def move(self, direction: Vec3 | Vec2, *, speed: float | None = None, run: bool = False) -> None:
        """Move this frame. `direction` is normalized; speed is `speed` m/s if given,
        else run/walk speed scaled by the direction's length (sticks). World space; for
        camera-relative sticks use `ctx.camera.main.relative(stick)`. Crouched, prone and
        carrying speeds cap it; swimming uses its y too."""
    def jump(self) -> bool:
        """Jumps if grounded, within coyote time, or with air jumps left — or vaults/climbs
        the ledge ahead, opens the parachute in free fall, climbs out of water. False when
        it did nothing (no headroom, prone, seated, mid-traversal)."""
    def launch(self, velocity: Vec3 | Vec2) -> None:
        """Set velocity outright (springs, bounce pads, knock-ups). Leaves the ground."""
    def knockback(self, push: Vec3 | Vec2) -> None:
        """Add `push` (m/s) to the velocity, whatever the character's mass (dashes, hits).
        Leaves the ground when `push` points up."""
    def stop(self) -> None: ...
    def face(self, yaw_deg: float) -> None: ...
    def teleport(self, position: Vec3 | Vec2, *, yaw: float | None = None) -> None: ...
    def set_stance(self, stance: Stance) -> bool:
        """Crouch, go prone or stand (needs `stances`; prone needs `stances.prone`). False
        when it can't: no headroom to rise, or not on the ground for prone."""
    def release_parachute(self) -> bool:
        """Cut the canopy: back to free fall. False without one open."""
    def hold(self, item: Entity, *, socket: str | None = None) -> bool:
        """Take `item` in hand: it rides the Model socket (default `hold_socket`), its
        colliders are off and physics leaves it alone until dropped. False when already
        holding something or `item` is held or carried by someone."""
    def drop(self) -> Entity | None:
        """Let go of the held item where it is (it falls). Returns it."""
    def throw(self, velocity: Vec3) -> Entity | None:
        """Let go of the held item moving at `velocity` (world m/s; dynamic bodies)."""
    def place(self, position: Vec3, *, yaw: float = 0) -> Entity | None:
        """Set the held item down at a world point and heading, at rest."""
    def lift(self, other: Entity) -> bool:
        """Lift `other` (a downed character, a crate) onto the shoulders (needs `carry`).
        A carried character's motion is "carried" and it doesn't move by itself."""
    def put_down(self) -> Entity | None:
        """Set the carried entity down at `carry.drop`, if there is room. Returns it."""
    def sit(self, seat: Entity) -> bool:
        """Take a Seat: blend onto it over its `enter_time`, then ride it. False when it is
        taken or disabled, or the character is holding a carried body."""
    def leave_seat(self) -> bool:
        """Stand up at the seat's first exit with room for the capsule. False when every
        exit is blocked (it stays seated)."""
    @property
    def grounded(self) -> bool: ...
    @property
    def ground(self) -> Entity | None:
        """What it's standing on (moving platforms, surfaces)."""
    @property
    def velocity(self) -> Vec3: ...
    @property
    def vehicle(self) -> Entity | None:
        """The Vehicle whose seat it is in (`seat` is that Seat child), else None."""
    @property
    def motion(self) -> Motion: ...
    @property
    def stance(self) -> Stance: ...
    @property
    def eye(self) -> Vec3:
        """World position of the eyes now (stance changes ease it)."""
    @property
    def ledge(self) -> Literal["vault", "climb"] | None:
        """What `jump()` would do at the ledge ahead now (prompts, AI); None: a plain jump."""
    @property
    def held(self) -> Entity | None: ...
    @property
    def carried(self) -> Entity | None:
        """What it carries on its shoulders."""
    @property
    def carrier(self) -> Entity | None:
        """Who carries it."""
    @property
    def seat(self) -> Entity | None: ...

@component("garment")
class Garment(EngineComponent):
    """A skinned model worn on its parent's skeleton: clothing, hair, armor. Put it on a
    child of an entity with a skinned Model (a Wardrobe does that for you): its Model is
    posed by the parent's posed bones instead of an Animator of its own, so it bends with
    every clip, IK, ragdoll and the animation level of detail of the body.

    Bones match by name, exactly or rig-neutrally ("mixamorig:Spine" = "Spine" =
    "spine_01"); bones the body lacks (a coat's tails) follow their parent bone rigidly.
    Model it on the body's skeleton, in the body's model space (export the body's rig with
    the garment). The garment entity is kept on the body's origin; its Model.offset nudges
    the fit in the bind pose, and the body's Model.offset applies to it too.

        "children": [{"name": "coat", "components": {
            "model": {"model": "models/leather_coat"},
            "garment": {"slot": "torso", "hides": ["Body_Torso"]}}}]
    """
    slot: str = field("", doc='The wardrobe slot it fills ("torso", "legs", "feet", "head", "hair"…): one garment per slot.')
    hides: list[str] = field([], doc="Parts of the body's Model hidden while it is worn (the skin under a sleeve).")

@component("wardrobe")
class Wardrobe(EngineComponent):
    """What a character wears, as data: slot → garment prefab. The garments follow from it
    every frame — each slot's prefab is spawned as a child Garment (its `slot` set), a
    changed slot is swapped, a removed one taken off — and the body parts they `hides`
    are hidden while worn. An outfit saves, replicates and replays with the entity;
    assigning `outfit` (another character's, a saved look) dresses at once.

        "wardrobe": {"outfit": {"torso": "leather_coat", "legs": "jeans"},
                     "tints": {"torso": "#7a4b2a"}}

        w = npc.get(Wardrobe)
        w.wear(Prefabs.cowboy_hat)                   # slot from its Garment ("head")
        w.wear(Prefabs.scarf, slot="neck", tint=Color.hex("#c0392b"))
        w.take_off("head")
        other.get(Wardrobe).outfit = w.outfit        # the same look
    """
    outfit: dict[str, PrefabRef] = field({}, doc="Slot → garment prefab (each with a Model; a Garment component is added if it has none).")
    tints: dict[str, Color] = field({}, doc="Slot → the garment Model's tint.")
    hidden: list[str] = field([], doc="The body's Model parts the worn garments hide (kept by the engine).")

    def wear(self, garment: PrefabRef, *, slot: str | None = None, tint: Color | None = None) -> Entity:
        """Wear a garment prefab in `slot` (None: its Garment's slot), replacing what is
        there; returns the garment entity."""
    def take_off(self, slot: str) -> bool:
        """Take off what `slot` wears. False when it is empty."""
    def worn(self, slot: str) -> Entity | None:
        """The garment entity in `slot`."""
    def slots(self) -> list[str]:
        """The slots worn, sorted."""

@component("seat")
class Seat(EngineComponent):
    """Somewhere a character sits or stands to use something: a chair, a turret, a console,
    a bed, a vehicle's seat (a Vehicle's Seat children are its seats: `Vehicle.enter/exit`
    sit and stand through here). A seated character rides the seat (moving seats carry it),
    its colliders are off, and it doesn't move by itself; its Animator's `seated` param is
    true (and `param`, when set). Positions are in the seat's frame (+z forward)."""
    offset: Vec3 = field(Vec3(0, 0, 0), unit="m", doc="Where the character's feet go.")
    facing: float = field(0, unit="deg", doc="The character's heading, relative to the seat's.")
    exits: list[Vec3] = field([], doc="Where `leave_seat()` may stand it up, tried in order; [] — where it came "
                                      "from (a vehicle seat: beside it, the other side, behind, the roof).")
    enter_time: float = field(0.4, min=0, unit="s")
    param: str | None = field(None, doc='An extra Animator bool param set while seated ("driving", "manning").')
    enabled: bool = field(True)
    occupant: Entity | None = field(None, doc="Who sits here (kept by the engine).")

@event("landed", target="entity")
class Landed:
    entity: Entity
    fall_speed: float
    """m/s downward at touchdown (≥ 0)."""
    target: Entity | None
    """What it landed on (None: terrain or other ground that isn't an entity)."""

@event("jumped", target="entity")
class Jumped:
    entity: Entity
    in_air: bool

@event("traversed", target="entity")
class Traversed:
    """A vault or climb started."""
    entity: Entity
    kind: Literal["vault", "climb"]
    height: float

@event("stance_changed", target="entity")
class StanceChanged:
    entity: Entity
    stance: Stance

@event("motion_changed", target="entity")
class MotionChanged:
    """`motion` changed (entered water, started free fall, opened the parachute…)."""
    entity: Entity
    motion: Motion
    previous: Motion

@event("seated", target="entity")
class Seated:
    """The character (`entity`) has sat down. The seat knows from `Seat.occupant`."""
    entity: Entity
    target: Entity
    """The seat."""

@event("left_seat", target="entity")
class LeftSeat:
    entity: Entity
    target: Entity
    """The seat."""
