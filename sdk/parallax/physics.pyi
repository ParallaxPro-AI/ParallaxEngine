"""Physics (physics2d / physics3d plugins, Rapier).

Rigidbody = motion, Collider = shape. A static wall has a Collider and no Rigidbody.
Nothing collides without a Collider. Acting on one body → Rigidbody methods;
asking about the world → `ctx.physics`.
"""

from typing import Literal, Sequence
from parallax import EngineComponent, Entity, Quat, SoundRef, Vec2, Vec3, component, event

class Layer:
    name: str

def layer() -> Layer: ...

class Layers:
    """Declare collision layers once and pass the class to the physics plugin:

    class Layers(physics.Layers):
        player = layer()
        enemy = layer()

    Collider data uses the names ("layer": "player", "collides_with": ["enemy"]); checked.
    """
    default: Layer


@component("rigidbody")
class Rigidbody(EngineComponent):
    kind: Literal["dynamic", "kinematic"] = ...
    mass: float = ...
    angular_velocity: Vec3 = ...
    """Degrees per second (2D: z)."""
    linear_damping: float = ...
    angular_damping: float = ...
    gravity_scale: float = ...
    lock_rotation: bool = ...
    """Hold every rotation axis still."""
    lock_axes: Sequence[Literal["x", "y", "z"]] = ...
    """Translation axes held still (2D: "z" locks rotation). A flat board in 3D: pieces
    take `lock_axes=["y"]` with `lock_rotation_axes=["x", "z"]`, so they slide and spin
    on the board's plane and never tip or leave it."""
    lock_rotation_axes: Sequence[Literal["x", "y", "z"]] = ...
    """Rotation axes held still, one by one (2D: "z" locks rotation)."""
    continuous: bool = ...
    """Swept collision for fast bodies (bullets, balls)."""

    @property
    def velocity(self) -> Vec3: ...
    @velocity.setter
    def velocity(self, value: Vec3 | Vec2) -> None:
        """2D games may assign a Vec2."""
    @property
    def speed(self) -> float: ...
    def impulse(self, impulse: Vec3 | Vec2, *, at: Vec3 | None = None) -> None: ...
    def force(self, force: Vec3 | Vec2) -> None:
        """Applied for this physics step only."""
    def teleport(self, position: Vec3 | Vec2, *, rotation: Vec3 | float | None = None,
                 keep_velocity: bool = False) -> None:
        """Move without sweeping through what's in between."""


@component("collider")
class Collider(EngineComponent):
    shape: Literal["box", "sphere", "circle", "capsule", "cylinder", "mesh", "convex"] = ...
    size: Vec3 = ...
    radius: float = ...
    height: float = ...
    offset: Vec3 = ...
    trigger: bool = ...
    layer: str = ...
    collides_with: Sequence[str] = ...
    friction: float = ...
    bounce: float = ...
    material: str | None = ...
    """A declared surface material; its friction and bounce replace the two fields above,
    and contacts raise `Impact` events. Checked against the Materials class."""


class Material:
    name: str

def material(*, friction: float = 0.5, bounce: float = 0, sound: SoundRef | None = None,
             impact_speed: float = 1) -> Material:
    """`impact_speed`: m/s of closing speed from which a contact is an `Impact`."""

class Materials:
    """Declare surface materials once and pass the class to the physics plugin:

    class Materials(physics.Materials):
        ice = material(friction=0.02)
        rubber = material(friction=1, bounce=0.8, sound=Assets.sfx.boing)

    Collider data names them ("material": "ice"); an unknown name is an error with a
    suggestion."""


@component("joint")
class Joint(EngineComponent):
    """A constraint between a body and what it is connected to. Put it on the body itself
    (`body=None`), or on any entity naming `body` (several joints on one body). Zero is the
    pose when the joint is built: angles and positions are measured from it.

    kinds: "fixed" (weld) · "hinge" (turns about `axis`; 2D: about the anchor) ·
    "slider" (moves along `axis`) · "ball" (3D: turns freely about the anchor) ·
    "rope" (at most `length` apart) · "spring" (`stiffness` N/m, `damping` N·s/m about
    `length`)."""
    kind: Literal["fixed", "hinge", "slider", "ball", "rope", "spring"] = ...
    body: Entity | None = ...
    """The body it holds; None: this entity."""
    connected: Entity | None = ...
    """What it holds the body to; None: the world (or the parent, with `to_parent`)."""
    to_parent: bool = ...
    anchor: Vec3 = ...
    """In the body's local space (scale applies, as for Collider.offset)."""
    connected_anchor: Vec3 | None = ...
    """In the connected entity's local space, or a world point; None: where `anchor` is
    when built (written back)."""
    axis: Vec3 = ...
    """Hinge axis / slide direction in the body's local space. Default +x."""
    limits: Vec2 | None = ...
    """(min, max): degrees for a hinge, meters for a slider."""
    length: float | None = ...
    """Rope: the most the anchors are apart; spring: rest length. None: as built (written back)."""
    stiffness: float = ...
    damping: float = ...
    motor_speed: float | None = ...
    """deg/s (hinge) or m/s (slider). Alone: run at it. With motor_target: the top speed."""
    motor_target: float | None = ...
    """deg (hinge) or m (slider): servo to it."""
    motor_max_force: float | None = ...
    """N·m (hinge) or N (slider) the motor can give; None: as much as it takes."""
    break_force: float | None = ...
    """N. It breaks (`JointBroken`, `broken = True`) when its load passes this."""
    collide_connected: bool = ...
    broken: bool = ...
    """Set when it breaks; set False to rebuild it on its anchors."""

    @property
    def angle(self) -> float | None:
        """Hinge: degrees from the built pose (None while broken)."""
    @property
    def position(self) -> float | None:
        """Slider: meters from the built pose."""
    @property
    def distance(self) -> float | None:
        """Meters between the two anchors now."""
    @property
    def load(self) -> float:
        """The force (N) it held the body with over the last step (estimated from the body's
        motion; a body held by several joints shares one estimate)."""
    def detach(self) -> None:
        """Break it now, without a `JointBroken` event."""


@component("force_field")
class ForceField(EngineComponent):
    """Pushes dynamic bodies every physics step: inside the entity's trigger Collider when
    it has one, else within `radius` of it (centre of mass), else everywhere."""
    kind: Literal["directional", "radial", "vortex"] = ...
    """directional: along `direction`; radial: away (negative strength: towards);
    vortex: around the `direction` axis (2D: around the entity), counter-clockwise."""
    strength: float = ...
    """m/s² (every mass alike), or N with mode="force"."""
    mode: Literal["acceleration", "force"] = ...
    direction: Vec3 = ...
    radius: float | None = ...
    falloff: Literal["none", "linear", "inverse_square"] = ...
    """linear: to 0 at `radius`; inverse_square: 1/d² (d ≥ 1 m)."""
    layers: Sequence[str] = ...
    """Collision layers it pushes; empty: all."""
    enabled: bool = ...


@component("ragdoll")
class Ragdoll(EngineComponent):
    """physics3d only. A body-part ragdoll laid over the entity's skinned skeleton (or the
    profile's own proportions without one). While it is on, the entity's own colliders are
    off and a Character doesn't move it; renderers draw the driven bones."""
    profile: Literal["humanoid"] = ...
    height: float = ...
    """m: the size of the profile's proportions (no skinned model)."""
    mass: float = ...
    strength: float = ...
    """How firmly an active ragdoll follows its animation (1: firm)."""
    blend: float = ...
    """Seconds `recover()` blends back to the animation by default."""

    @property
    def mode(self) -> Literal["limp", "active", "recovering"] | None: ...
    @property
    def weight(self) -> float:
        """1: the physics pose is drawn; 0: the animation (blending between while recovering)."""
    def go_limp(self, impulse: Vec3 | None = None, *, at: Vec3 | None = None) -> None:
        """Full ragdoll; `impulse` (N·s) hits the part nearest `at` (else the pelvis).
        The entity follows the pelvis."""
    def activate(self, strength: float | None = None) -> None:
        """Active ragdoll: the pelvis follows the entity, every joint servos to the animated
        pose — hits make it react and it pulls back."""
    def recover(self, blend: float | None = None) -> None:
        """Stand up where the pelvis lies (from limp) and blend back to the animation."""


@event("joint_broken", target="entity")
class JointBroken:
    entity: Entity
    """The joint's entity."""
    body: Entity | None
    connected: Entity | None
    force: float
    """The load (N) that broke it; 0 when one of its bodies went away."""

@event("impact", target="entity")
class Impact:
    """A contact starting with the surfaces closing at least at the material's impact_speed;
    one per side that has a material."""
    entity: Entity
    target: Entity
    """The other side."""
    point: Vec3
    normal: Vec3
    speed: float
    material: str
    target_material: str | None
    sound: SoundRef | None
    """This side's material sound."""


class RayHit:
    """What a raycast or shape cast hit. Not `parallax.combat.DamageHit`."""
    entity: Entity | None
    """What was hit; None for world geometry that isn't an entity (terrain, voxels)."""
    point: Vec3
    normal: Vec3
    distance: float


class PhysicsApi:
    @property
    def gravity(self) -> float:
        """The configured gravity along y (m/s²)."""
    def raycast(self, origin: Vec3 | Vec2, direction: Vec3 | Vec2, max_distance: float = 1000,
                *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> RayHit | None: ...
    def raycast_all(self, origin: Vec3 | Vec2, direction: Vec3 | Vec2, max_distance: float = 1000,
                    *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> list[RayHit]: ...
    def overlap(self, center: Vec3 | Vec2, radius: float,
                *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> list[Entity]:
        """Entities whose collider *shapes* touch a sphere/circle. (Positions only:
        `Query.near`.)"""
    def overlap_box(self, center: Vec3 | Vec2, size: Vec3 | Vec2,
                    *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> list[Entity]: ...
    def explode(self, center: Vec3 | Vec2, radius: float, strength: float) -> list[Entity]: ...

    # Shape casts: the first solid hit of a shape swept along `direction`; `distance` is how
    # far it travelled before touching (0: it overlapped at the start).
    def sphere_cast(self, origin: Vec3, radius: float, direction: Vec3, max_distance: float = 1000,
                    *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> RayHit | None:
        """3D."""
    def circle_cast(self, origin: Vec2 | Vec3, radius: float, direction: Vec2 | Vec3, max_distance: float = 1000,
                    *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> RayHit | None:
        """2D."""
    def box_cast(self, origin: Vec3 | Vec2, size: Vec3 | Vec2, direction: Vec3 | Vec2, max_distance: float = 1000,
                 *, rotation: Vec3 | Quat | float | None = None,
                 layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> RayHit | None:
        """`rotation`: euler degrees or a Quat (3D), degrees (2D)."""
    def capsule_cast(self, origin: Vec3 | Vec2, radius: float, height: float, direction: Vec3 | Vec2,
                     max_distance: float = 1000, *, layers: Sequence[Layer] = (),
                     ignore: Sequence[Entity] = ()) -> RayHit | None:
        """Standing along y; `height` includes the caps."""
    def sweep(self, entity: Entity, direction: Vec3 | Vec2, distance: float,
              *, layers: Sequence[Layer] = (), ignore: Sequence[Entity] = ()) -> RayHit | None:
        """The entity's own collider swept from where it is (it never hits itself)."""
