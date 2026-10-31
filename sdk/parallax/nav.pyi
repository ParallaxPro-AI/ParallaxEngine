"""Navigation plugin: pathfinding agents over walkable surfaces on several levels (3D scenes).

Every surface an agent can stand on is part of the nav world, one level per height: the
ground, a bridge deck over the road, each floor of a building, its roof. A path stays on
its level and changes level only by stepping (stairs, ramps), by a link, or — for agents
with `jump_height` / `drop_height` — by jumping onto or dropping off a ledge.

Links join places walking doesn't: put a `NavLink` on a prefab (a ladder, a gap, a door,
a teleporter) or list them in the scene, `"navmesh": {"links": [{"start": [x, y, z],
"end": [x, y, z], "kind": "climb"}]}`. A collider with a `NavObstacle` is a dynamic
obstacle (a door, a crate pushed around): agents re-plan when it moves across their path.
Agents with `avoid_others` steer around each other reciprocally (no pushing through).

Water: terrain under the terrain's `water_level` is no ground. A fordable river or a
shallow marsh sets `"navmesh": {"wade_depth": 1.5}`: ground at most that many meters
under the water is walked (deeper water still blocks).

The scene "navmesh" block (optional; any other key is PP3240):

    "navmesh": {
        "obstacles": ["terrain", "wall"],   # collision layers nav avoids (default: every static collider)
        "links": [{"start": [x, y, z], "end": [x, y, z],   # off-mesh links, world space
                   "kind": "jump",          # jump | climb | door | teleport | custom (default jump)
                   "bidirectional": true,   # default true
                   "cost": 0}],             # extra meters, >= 0 (default 0)
        "wade_depth": 0,                    # meters of water still walked (default 0)
        "from": "assets/models/ground.glb"  # checked to be a path, NOT read: nav already reads
    }                                       # the scene's static colliders (a ground mesh collider)

3D only: every point is a Vec3. A Vec2 is PP3242 (for 2D boards use the grid plugin's
`Grid.path`; `vec2.to_ground()` turns a Vec2 into a ground Vec3).
"""

from typing import Literal

from parallax import EngineComponent, Entity, Vec3, component, event, field

LinkKind = Literal["jump", "climb", "door", "teleport", "custom"]

@component("nav_agent")
class NavAgent(EngineComponent):
    speed: float = field(3.5, unit="m/s", modifiable=True)
    radius: float = field(0.4, unit="m")
    stopping_distance: float = field(0.5, unit="m")
    avoid_others: bool = field(True, doc="Steer around other agents (reciprocal avoidance).")
    drives_body: bool = field(True, doc="False: compute steering only (read `desired_velocity`) "
                                        "and move the body yourself — vehicles, tanks.")
    jump_height: float = field(0, unit="m", doc="Highest ledge it jumps up onto (crates, walls); 0: never. "
                                                "Also lets it jump level gaps up to its diameter + 1.5 m.")
    drop_height: float = field(0, unit="m", doc="Deepest drop it takes off a ledge (roofs, balconies); 0: never.")

    def move_to(self, target: Vec3 | Entity) -> bool:
        """Path to a point, or keep following an entity. False if unreachable. A point's y
        picks the level: Vec3(x, 4, z) is the floor at 4 m, not the ground below it."""
    def stop(self) -> None: ...
    @property
    def moving(self) -> bool: ...
    @property
    def destination(self) -> Vec3 | None: ...
    @property
    def desired_velocity(self) -> Vec3: ...
    @property
    def traversing(self) -> Literal["jump", "drop", "climb", "door", "teleport", "custom"] | None:
        """The kind of link it is on now, or None while it walks."""

@component("nav_link")
class NavLink(EngineComponent):
    """An off-mesh link: agents may go from `start` to `end` (and back, when bidirectional)
    by `kind`. Both are offsets from the entity, in its frame. With `drives_body`, agents
    jump (an arc), climb (straight, half speed), walk through a door, or teleport;
    otherwise the game moves them (see LinkStarted)."""
    start: Vec3 = field(Vec3(0, 0, 0), unit="m")
    end: Vec3 = field(Vec3(0, 0, 2), unit="m")
    kind: LinkKind = field("jump")
    bidirectional: bool = field(True)
    cost: float = field(0, min=0, unit="m", doc="Extra cost on top of its length: higher, and agents walk around when they can.")
    enabled: bool = field(True, doc="False: no agent uses it (a locked door). Agents re-plan when it changes.")

@component("nav_obstacle")
class NavObstacle(EngineComponent):
    """Makes the entity's Collider a dynamic obstacle, even with a Rigidbody: nav rebuilds
    only the tiles it touched when it moves, turns or is switched, and agents whose path it
    now blocks re-plan."""
    enabled: bool = field(True, doc="False: agents path through it (an open door).")
    move_threshold: float = field(0.1, min=0, unit="m", doc="How far it moves before nav notices.")

@event("arrived", target="entity")
class Arrived:
    entity: Entity

@event("link_started", target="entity")
class LinkStarted:
    """An agent reached the start of a link (`target`: its NavLink entity; None for automatic
    jumps and drops and scene links). Play the jump or climb animation here; agents that
    don't drive their body make the move themselves (e.g. `Character.jump()`)."""
    entity: Entity
    kind: Literal["jump", "drop", "climb", "door", "teleport", "custom"]
    target: Entity | None

class NavApi:
    def path(self, start: Vec3, end: Vec3, *, agent: Entity | None = None) -> list[Vec3]:
        """Waypoints from start to end ([] if unreachable). Each end is on the level nearest
        its y. `agent`: an Entity with a NavAgent, whose radius, jump_height and drop_height
        the path is for (default: the plugin's agent_radius, walking only)."""
    def reachable(self, start: Vec3, end: Vec3, *, agent: Entity | None = None) -> bool: ...
    def random_point(self, near: Vec3, radius: float) -> Vec3 | None: ...
    def can_see(self, viewer: Entity, target: Entity, *, fov: float = 120, distance: float = 30) -> bool: ...
