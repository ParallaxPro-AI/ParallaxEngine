"""Headless, deterministic playtests (fixed seed, fixed timestep).

The test runner collects `@playtest` functions AND plain `test_*` functions (for pure
rules modules). Test files may import the game's own modules and share helpers with
game code."""

from typing import Any, Awaitable, Callable, Literal, TypeVar
from parallax import Axis1, Axis2, Button, ButtonGroup, Context, Entity, Panel, SceneRef, Vec2, Vec3, World

R = TypeVar("R")
E = TypeVar("E")

class GameHarness:
    world: World
    ctx: Context
    """The game's context, read-write: set up state directly (start a quest, grant
    gold) or read anything a test needs. Writes happen between frames."""
    async def start(self, *, scene: SceneRef | None = None, seed: int = 1, players: int = 1) -> None: ...
    async def press(self, action: Button, *, player: int = 0) -> None:
        """A click: down and up within one frame. That frame `pressed` and `released` are
        true and `held` is not — read `pressed` for actions a click should trigger."""
    async def press_index(self, group: ButtonGroup, index: int, *, player: int = 0) -> None: ...
    async def hold(self, action: Button, seconds: float | None = None, *, player: int = 0) -> None:
        """Hold a button for `seconds`, advancing the game, then let go. Without `seconds`
        it only goes down and stays down through every later command — move, press,
        advance, read a `while held` panel — until `release(action)`:

            await game.hold(Controls.aim)                         # stays down
            await game.move(Controls.walk, vec2(0, 1), seconds=1)  # walks while aiming
            assert game.is_open(Scope)
            await game.release(Controls.aim)"""
    async def move(self, action: Axis2, direction: Vec2, seconds: float | None = None, *, player: int = 0) -> None:
        """Push a stick for `seconds` (advancing), then center it; without `seconds`, keep
        it pushed until `release(action)`."""
    async def set_axis(self, action: Axis1, value: float, seconds: float | None = None, *, player: int = 0) -> None:
        """Hold an axis at `value` for `seconds` (advancing), then zero it; without
        `seconds`, keep it there until `release(action)`."""
    async def release(self, action: Button | Axis1 | Axis2, *, player: int = 0) -> None:
        """Let go of an action held, moved or set without `seconds`; advances one frame (the
        one where `released` is true). PP3449 when it isn't being held."""
    async def tap(self, screen: Vec2) -> None: ...
    async def tap_world(self, point: Vec3 | Vec2) -> None:
        """Press and release over a world point; advances exactly one frame. A Vec2 is (x, y)
        on the play plane in 2D, and the ground point (x, z) in 3D (on the terrain there)."""
    async def tap_entity(self, entity: Entity) -> None: ...
    async def type_text(self, text: str) -> None: ...
    async def click(self, panel: type[Panel], action: str, *, player: int = 0, **data: Any) -> None: ...
    async def advance(self, *, seconds: float = 0, frames: int = 0) -> None: ...
    async def advance_until(self, condition: Callable[[], bool], *, timeout: float = 10) -> None: ...
    async def until(self, event_type: type[E], *, timeout: float = 10) -> E:
        """Advance until an event is emitted; returns it. Fails the test on timeout."""
    def get(self, resource: type[R]) -> R: ...
    def config(self, kind: type[R], **fields: Any) -> R:
        """The game's config. With `fields`, change them for this test's game first
        (`h.config(Rules, result_delay_seconds=0)`); game code still can't write config."""
    def is_open(self, panel: type[Panel], *, player: int = 0) -> bool: ...
    def panel_state(self, panel: type[Panel], *, player: int = 0) -> dict[str, Any]: ...
    def emitted(self, event_type: type[E]) -> list[E]: ...
    def observe(self, *, entities: Literal["all", "drawn"] = "all") -> dict[str, Any]:
        """What the game shows now, as `parallax test --observe` reports it ("parallax.observation"):
        "camera" (pose, viewport, matrices), "entities" (id, placedId, prefab, tags, components,
        position, drawn, bounds, screen box, onScreen) and "panels" (id, actions, state).
        `entities="drawn"`: only what was drawn last frame."""

def playtest(name: str) -> Callable[[Callable[[GameHarness], Awaitable[None]]], Callable[[GameHarness], Awaitable[None]]]: ...
