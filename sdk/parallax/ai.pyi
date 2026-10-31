"""Game AI (plugins.ai()): behavior trees and blackboards, perception, squads and tactics,
a combat director, RTS orders, flocks, and fog of war. 3D (Vec3 points).

Behavior trees are data. Write one in content/behavior_tree/<id>.json —

    {"tick": 0.1,
     "root": {"type": "selector", "children": [
       {"type": "sequence", "name": "combat", "children": [
         {"type": "check", "key": "target_visible"},
         {"type": "move_to", "key": "target", "stopping_distance": 8},
         {"type": "do", "task": "shoot", "args": {"burst": 3}}]},
       {"type": "do", "task": "patrol"}]}}

— or build the same document in Python with the node constructors below, and register it:

    GUARD = Tree("guard", Selector(
        Sequence(Check("target_visible"), MoveTo("target", stopping_distance=8), Do("shoot", burst=3), name="combat"),
        Do("patrol")))
    Game(..., plugins=[plugins.nav(), plugins.ai(trees=[GUARD], tasks=[Task("shoot", shoot), Task("patrol", patrol)])])

and put `Brain(tree="guard")` on the NPC. A tree's leaves that act are tasks: functions
`def shoot(ctx, agent: Agent) -> Status` registered with `Task`, returning SUCCESS, FAILURE
or RUNNING (or True / False). A task keeps its memory in `agent.blackboard`, so a snapshot
restores a brain mid-task. Every tree is checked when the game starts (and by `parallax
check` for content trees): unknown node types, keys, ops and unregistered tasks are errors.

How nodes run (deterministic: world order, the AI's seeded random stream, the AI clock):
  - sequence resumes its running child, re-testing the `check` children before it each tick;
  - selector is reactive: it re-evaluates from its first child every tick, so a higher
    priority that stops failing interrupts a lower one (`memory=True` resumes instead);
  - parallel ticks every unfinished child ("all" / "any" policies, failure first);
  - an interrupted node stops everything running under it: tasks get `stop`, moves end;
  - repeat runs at most one iteration per tick; wait / cooldown / timeout use seconds.

Perception writes what an NPC knows into its Brain's blackboard after every update:
`target` (Entity), `target_visible`, `target_position`, `target_distance`, `awareness`
(0..1), `alert` ("unaware" | "suspicious" | "alert"), `heard_position`, `last_seen_age`
(absent when there is nothing to say). An NPC with the HUD's `Awareness` gets its meter set.
"""

from typing import Any, Callable, Literal, Sequence as Seq
from parallax import Context, EngineComponent, Entity, Tag, Vec3, component, content, event, field

Status = Literal["success", "failure", "running"]
SUCCESS: Status
FAILURE: Status
RUNNING: Status
Formation = Literal["line", "column", "wedge", "box", "circle", "echelon"]
Op = Literal["truthy", "falsy", "exists", "missing", "==", "!=", "<", "<=", ">", ">="]
Curve = Literal["linear", "inverse", "quadratic", "inverse_quadratic", "smoothstep", "step", "bool"]
Value = None | bool | int | float | str | Vec3 | Entity | list[Any]
Node = dict[str, Any]


# ─────────────────────────────────────────────────────────────────────────────
# Brains and blackboards
# ─────────────────────────────────────────────────────────────────────────────

class Blackboard:
    """A brain's (or squad's) memory: names to values (None, bool, numbers, str, Vec3,
    Entity, lists of them). An Entity reads as absent once destroyed; `ttl` expires a key."""
    def get(self, key: str, default: Value = None) -> Value: ...
    def set(self, key: str, value: Value, *, ttl: float | None = None) -> None: ...
    def has(self, key: str) -> bool: ...
    def clear(self, key: str | None = None) -> None:
        """Remove one key, or every key."""
    def keys(self) -> list[str]: ...

@component("brain")
class Brain(EngineComponent):
    """Runs a behavior tree. Changing `tree` interrupts the old one and starts the new one
    (the blackboard is kept; the tree's own `blackboard` fills keys that are missing)."""
    tree: str | None = field(None, doc="A behavior_tree content id or a Tree registered with ai(trees=...).")
    tick: float | None = field(None, min=0, unit="s", doc="Seconds between ticks; None: the tree's `tick`. "
                                                          "Brains are staggered by entity so they don't all tick at once.")
    enabled: bool = field(True, doc="False interrupts the tree and stops ticking.")
    @property
    def blackboard(self) -> Blackboard: ...
    @property
    def status(self) -> Literal["idle", "success", "failure", "running"]: ...
    @property
    def running(self) -> list[str]:
        """Paths of the running leaves, e.g. ["selector/combat/shoot"]."""
    def describe(self) -> str:
        """The last tick's walk, one node per line with its status — what the AI is thinking."""
    def restart(self) -> None:
        """Interrupt everything and start the tree from its root on the next step."""

class Agent:
    """What a task receives."""
    entity: Entity
    blackboard: Blackboard
    elapsed: float
    """Seconds since this task started running."""
    dt: float
    """Seconds since the brain's last tick."""
    node: str
    """The `do` node's name (or the task's)."""
    def arg(self, name: str, default: Value = ...) -> Value:
        """The node's argument (`Do("shoot", burst=3)` → arg("burst")); missing without a default: PP3253."""

TaskFn = Callable[[Context, Agent], Status | bool]

class Task:
    """A leaf the trees run with Do(name). `start` runs when it begins, `tick` every tick,
    `stop` when it ends for any reason (finished or interrupted)."""
    def __init__(self, name: str, tick: TaskFn, *, start: Callable[[Context, Agent], None] | None = None,
                 stop: Callable[[Context, Agent], None] | None = None) -> None: ...

class Tree:
    """A tree built in code: the same document as content/behavior_tree/<id>.json."""
    def __init__(self, id: str, root: Node, *, blackboard: dict[str, Value] | None = None, tick: float = 0.1) -> None: ...

@content("behavior_tree")
class BehaviorTreeDef:
    """Built-in content kind: content/behavior_tree/<id>.json."""
    root: Any
    blackboard: dict[str, Any] = field({})
    tick: float = field(0.1, min=0, unit="s")

# Node constructors (each returns the node document). Every one takes `name=` for traces.
def Sequence(*children: Node, name: str | None = None) -> Node: ...
def Selector(*children: Node, memory: bool = False, name: str | None = None) -> Node: ...
def Parallel(*children: Node, succeed: Literal["all", "any"] = "all", fail: Literal["all", "any"] = "any", name: str | None = None) -> Node: ...
def Random(*children: Node, weights: list[float] | None = None, name: str | None = None) -> Node:
    """One child, picked by weight when entered."""
def Invert(child: Node, *, name: str | None = None) -> Node: ...
def Succeed(child: Node, *, name: str | None = None) -> Node: ...
def Fail(child: Node, *, name: str | None = None) -> Node: ...
def Repeat(child: Node, *, times: int | None = None, until: Literal["success", "failure"] | None = None, name: str | None = None) -> Node:
    """Without `until` a failure fails it; with `until` that status ends it in success. After
    `times` iterations: success (without until) or failure (with)."""
def Retry(child: Node, times: int, *, name: str | None = None) -> Node:
    """Run again after a failure, up to `times` more attempts."""
def Cooldown(child: Node, seconds: float, *, name: str | None = None) -> Node:
    """Fails for `seconds` after the child ends."""
def Timeout(child: Node, seconds: float, *, name: str | None = None) -> Node:
    """Interrupts the child and fails after `seconds`."""
def Guard(check: Node, child: Node, *, name: str | None = None) -> Node:
    """`check` (a Check) is re-tested every tick; false interrupts the child."""
def Check(key: str, op: Op = "truthy", value: Value = ..., *, name: str | None = None) -> Node: ...
def Wait(seconds: float | tuple[float, float], *, name: str | None = None) -> Node:
    """A (lo, hi) range is picked when entered."""
def SetValue(key: str, value: Value, *, ttl: float | None = None, name: str | None = None) -> Node: ...
def Add(key: str, value: float = 1, *, name: str | None = None) -> Node:
    """Add to a number (absent counts as 0)."""
def Clear(key: str, *, name: str | None = None) -> Node: ...
def Do(task: str, *, name: str | None = None, **args: Value) -> Node: ...
def MoveTo(key: str, *, stopping_distance: float | None = None, speed: float | None = None, name: str | None = None) -> Node:
    """Walk the NavAgent to the blackboard's Vec3 or Entity (re-issued when it changes).
    Succeeds on arrival; fails when unreachable or absent."""
def Subtree(tree: str, *, name: str | None = None) -> Node:
    """Another tree's root, inlined."""
def Consider(key: str, curve: Curve = "linear", min: float = 0, max: float = 1, weight: float = 1) -> dict[str, Any]:
    """A utility consideration: the blackboard number through a curve onto 0..1; weight 0 ignores it."""
def Option(child: Node, *considerations: dict[str, Any], base: float = 1) -> dict[str, Any]: ...
def Utility(*options: dict[str, Any], hysteresis: float = 0.1, name: str | None = None) -> Node:
    """Runs the best-scoring option (base × considerations); the running one keeps +hysteresis
    so near ties don't flap. Fails when every score is 0."""
def Step(name: str, child: Node, *, cost: float = 1, pre: dict[str, Any] | None = None,
         effects: dict[str, Value] | None = None) -> dict[str, Any]:
    """A planner action. `pre` / goal facts: {"key": value} or {"key": {"op": ">", "value": 0}}."""
def Plan(goal: dict[str, Any], *steps: dict[str, Any], max_depth: int = 6, name: str | None = None) -> Node:
    """Plans the cheapest chain of steps from the blackboard to `goal`, runs each step's child,
    writes its effects when it succeeds, and re-plans when the next step's `pre` stops holding."""


# ─────────────────────────────────────────────────────────────────────────────
# Perception
# ─────────────────────────────────────────────────────────────────────────────

@component("perception")
class Perception(EngineComponent):
    """Sight, hearing and memory. Perceives `targets`-tagged entities, or (without it) other
    Sides. Sight: within `sight_range` (no farther than the weather's `visibility` with
    weather(): fog, rain and snow shorten it), inside `fov` on the ground plane or within
    `close_range` in any direction, and a clear line from the eye — physics raycasts with
    physics3d, else nav's walls, else open ground — not hidden by smoke (block_sight), nor
    in a terrain brush volume the perceiver isn't standing in (tall grass: `terrain.pyi`).
    Awareness rises while seen (`notice_time` seconds at full visibility, slower far away and
    for low `Detectable.visibility`); at 1 the target is spotted (Spotted). Unseen, a spotted
    target stays hunted at its last position for `memory` seconds, then drops to suspicious
    (LostTarget); unspotted awareness calms over `calm_time`. Hearing raises awareness from
    noises (ctx.ai.noise) but never spots."""
    sight_range: float = field(20, min=0, unit="m", modifiable=True)
    fov: float = field(120, min=0, max=360, doc="Degrees.", modifiable=True)
    eye_height: float = field(1.6, min=0, unit="m")
    close_range: float = field(2, min=0, unit="m", doc="Noticed in any direction this close.")
    hearing: float = field(1, min=0, doc="× a noise's loudness; 0: deaf.", modifiable=True)
    memory: float = field(10, min=0, unit="s")
    notice_time: float = field(1, min=0, unit="s", doc="0: noticed at once.")
    calm_time: float = field(8, min=0, unit="s")
    suspicious: float = field(0.35, min=0, max=1, doc="Awareness at which the NPC turns suspicious.")
    targets: Tag | None = field(None, doc="Perceive entities with this tag; None: other Sides.")
    interval: float = field(0.2, min=0, max=2, unit="s")
    @property
    def target(self) -> Entity | None:
        """The primary target: spotted and seen, then spotted, then the most aware of."""
    @property
    def alert(self) -> Literal["unaware", "suspicious", "alert"]: ...
    @property
    def awareness(self) -> float:
        """Of the primary target."""
    @property
    def known(self) -> list[Entity]: ...
    def sees(self, target: Entity) -> bool: ...
    def aware_of(self, target: Entity) -> float: ...
    def last_seen(self, target: Entity) -> Vec3 | None: ...
    def alarm(self, position: Vec3, *, target: Entity | None = None) -> None:
        """Alert it (an alarm bell, a radio call): to `target` at `position`, or just to look there."""
    def forget(self, target: Entity | None = None) -> None: ...

@component("detectable")
class Detectable(EngineComponent):
    """How visible this entity is to Perception (crouching, shadows, camouflage)."""
    visibility: float = field(1, min=0, doc="× how fast it is noticed; 0: invisible to sight.", modifiable=True)
    height: float = field(1, min=0, unit="m", doc="Where eyes look at it, above its origin.")

@event("spotted", target="entity")
class Spotted:
    entity: Entity
    target: Entity

@event("suspicious", target="entity")
class Suspicious:
    entity: Entity
    position: Vec3

@event("lost_target", target="entity")
class LostTarget:
    entity: Entity
    target: Entity
    position: Vec3

@event("heard_noise", target="entity")
class HeardNoise:
    entity: Entity
    position: Vec3
    source: Entity | None
    kind: Tag | None


# ─────────────────────────────────────────────────────────────────────────────
# Squads, cover, orders, flocks, fog of war
# ─────────────────────────────────────────────────────────────────────────────

@component("squad_member")
class SquadMember(EngineComponent):
    squad: str = field()
    role: str = field("", doc='"leader" leads; flank() moves members whose role it names.')

@component("cover_point")
class CoverPoint(EngineComponent):
    """A place to take cover (beside a crate, a wall corner). Without any in range, find_cover samples the ground."""
    height: float = field(1.2, min=0, unit="m", doc="Of the cover; a crouched head is at 0.75 × this.")

@component("orders")
class Orders(EngineComponent):
    """An RTS unit (needs a NavAgent). It never deals damage: read `engaging` / `target` and fire."""
    stance: Literal["aggressive", "defensive", "passive"] = field("aggressive",
        doc="aggressive: acquire within acquire_range and chase; defensive: only within attack_range; passive: never.")
    attack_range: float = field(6, min=0, unit="m", modifiable=True)
    acquire_range: float = field(10, min=0, unit="m", modifiable=True)
    def move(self, point: Vec3, *, queue: bool = False) -> None: ...
    def attack(self, target: Entity, *, queue: bool = False) -> None: ...
    def attack_move(self, point: Vec3, *, queue: bool = False) -> None: ...
    def patrol(self, points: list[Vec3], *, queue: bool = False) -> None: ...
    def hold(self, *, queue: bool = False) -> None: ...
    def stop(self) -> None: ...
    @property
    def order(self) -> Literal["idle", "move", "attack", "attack_move", "patrol", "hold"]: ...
    @property
    def target(self) -> Entity | None: ...
    @property
    def engaging(self) -> bool:
        """A live target within attack_range."""
    @property
    def queued(self) -> int: ...

@event("order_done", target="entity")
class OrderDone:
    entity: Entity
    order: str

@component("flock")
class Flock(EngineComponent):
    """Boids: birds, fish shoals, ambient crowds (`flat`). Moves the transform directly."""
    group: str = field("default")
    max_speed: float = field(4, min=0, unit="m/s", modifiable=True)
    min_speed: float = field(1, min=0, unit="m/s")
    acceleration: float = field(8, min=0, unit="m/s²")
    neighbor_radius: float = field(3, min=0, unit="m")
    separation_radius: float = field(1, min=0, unit="m")
    cohesion: float = field(1, min=0)
    alignment: float = field(1, min=0)
    separation: float = field(1.5, min=0)
    wander: float = field(0.3, min=0)
    home: Vec3 | None = field(None, doc="A soft leash: steer back once farther than home_radius.")
    home_radius: float = field(10, min=0, unit="m")
    avoid: Tag | None = field(None, doc="Flee entities with this tag (predators, the player's boat).")
    avoid_radius: float = field(5, min=0, unit="m")
    flee: float = field(2, min=0)
    flat: bool = field(False, doc="Keep its height (ground crowds, a fish band).")
    @property
    def velocity(self) -> Vec3: ...
    def push(self, impulse: Vec3) -> None: ...

@component("vision")
class Vision(EngineComponent):
    """Reveals fog of war for its team around it (walls block it with nav)."""
    range: float = field(8, min=0, unit="m", modifiable=True)
    team: Tag | None = field(None, doc="None: its Side.")

class Squad:
    name: str
    members: list[Entity]
    leader: Entity | None
    blackboard: Blackboard
    formation: Formation
    spacing: float
    share_targets: bool
    """A member that spots a target alerts the others (default True)."""
    def set_formation(self, shape: Formation, *, spacing: float | None = None) -> None: ...
    def slot(self, member: Entity) -> Vec3 | None:
        """Its place in formation around the leader."""
    def move(self, point: Vec3, *, formation: Formation | None = ..., spacing: float | None = None, queue: bool = False) -> None: ...
    def assign_cover(self, threat: Entity | Vec3, *, radius: float = 15, key: str = "cover") -> int:
        """Reserve distinct cover for each member with a Brain, written to its blackboard; returns how many."""
    def flank(self, threat: Entity | Vec3, *, distance: float = 8, roles: list[str] = ["flanker"], key: str = "flank") -> int: ...
    def alarm(self, target: Entity, position: Vec3 | None = None) -> None: ...

class DirectorApi:
    """Pacing: build (spawns allowed; intensity rises from report()) → peak (peak_seconds) →
    relax (no spawns, at least relax_seconds and until intensity <= relax_below) → build."""
    phase: Literal["build", "peak", "relax"]
    intensity: float
    budget: float
    alive: int
    def report(self, amount: float) -> None:
        """Add intensity (player hurt: damage / max health; a close call: 0.1…)."""
    def can_spawn(self, cost: float = 1) -> bool: ...
    def spawned(self, entity: Entity, cost: float = 1) -> None: ...
    def configure(self, **settings: float) -> None: ...

class Director:
    def __init__(self, *, budget_per_minute: float = 20, budget_cap: float = 20, max_alive: int = 12,
                 peak_intensity: float = 0.8, peak_seconds: float = 10, relax_seconds: float = 15,
                 relax_below: float = 0.3, decay: float = 0.03) -> None: ...

@event("director_phase")
class DirectorPhase:
    phase: str
    intensity: float

class FogApi:
    """Per-team visibility on the ground (cells of ai(fog_cell=...) meters)."""
    teams: list[str]
    def visible(self, team: Tag, point: Vec3) -> bool: ...
    def explored(self, team: Tag, point: Vec3) -> bool: ...
    def sees(self, team: Tag, entity: Entity) -> bool:
        """For net(visible=...): `lambda ctx, player, e: ctx.ai.fog.sees(Blue, e)`."""
    def reveal(self, team: Tag, center: Vec3, radius: float, seconds: float) -> None:
        """A scan or flare: visible through walls for a while."""

class AiApi:
    director: DirectorApi
    fog: FogApi
    def squad(self, name: str) -> Squad: ...
    def noise(self, at: Vec3, loudness: float = 10, *, source: Entity | None = None, kind: Tag | None = None) -> None:
        """Carries `loudness` meters (half through walls). Footsteps ~6, gunshots ~40."""
    def block_sight(self, center: Vec3, radius: float, seconds: float, *, density: float = 1, grow: float = 0.5,
                    fade: float = 1) -> None:
        """Smoke: dims and blocks sight through it (perception and line_of_sight), not bullets."""
    def line_of_sight(self, a: Entity | Vec3, b: Entity | Vec3) -> bool: ...
    def find_cover(self, agent: Entity, threat: Entity | Vec3, *, radius: float = 15, min_distance: float = 3,
                   peek: bool = False, reserve: bool = True) -> Vec3 | None:
        """The nearest reachable place hidden from the threat (CoverPoints, else sampled), reserved
        for the agent. `peek`: standing up there must see the threat."""
    def release_cover(self, agent: Entity) -> None: ...
    def flank_position(self, agent: Entity, threat: Entity | Vec3, *, distance: float = 8,
                       side: Literal["left", "right"] | None = None) -> Vec3 | None: ...
    def safe_spot(self, agent: Entity, threats: Seq[Entity | Vec3], *, radius: float = 12) -> Vec3 | None: ...
    def formation(self, center: Vec3, facing: Vec3, count: int, *, shape: Formation = "line", spacing: float = 2) -> list[Vec3]: ...
    def command(self, units: Seq[Entity], order: Literal["move", "attack", "attack_move", "patrol", "hold", "stop"],
                target: Entity | Vec3 | list[Vec3] | None = None, *, formation: Formation | None = "box",
                spacing: float = 2, queue: bool = False) -> None:
        """One order for a group: moves go to formation slots facing the way the group travels, at
        the slowest unit's pace."""
