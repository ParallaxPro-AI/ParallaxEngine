"""Grid plugin: boards, tile maps and anything laid out in cells.

A board is an entity with a `Grid`. Things on it carry `GridCell(cell=...)`; the grid
keeps an index so "what's at this cell" is a lookup, not a scan. Moving a piece is
setting its cell (and tweening its transform with `grid.center(cell)` if you want it
animated — the grid never moves transforms by itself).
"""

from typing import Any, Iterator, Sequence
from parallax import EngineComponent, Entity, Tag, TagFilter, Vec2, Vec3, component, event, field
from parallax.values import Cell as Cell


@component("grid")
class Grid(EngineComponent):
    cols: int = field(8)
    rows: int = field(8)
    cell_size: Vec2 = field()
    """Meters per cell (x, y in 2D; x, z on the ground in 3D)."""
    plane: str = field("xy", choices=["xy", "xz"])
    origin: str = field("center", choices=["center", "corner"])
    """center: the entity's position is the middle of the board. corner: it's the outer
    corner of cell (0, 0)."""
    row_order: str = field("down", choices=["down", "up"])
    """down: row 0 is the top row, as text reads. Text rows read like a map: the first row
    is the top (+z on the ground; +y on an "xy" board), rows run toward -z (-y), and columns
    run along +x. up: row 0 is the bottom."""

    def center(self, cell: Cell) -> Vec3:
        """Cell center as a world point: on an "xy" board its x, y are the plane's (`.xy()` for
        a Vec2), on "xz" its x, z. In 2D, pass it straight to `spawn(at=)` / `move_to` —
        draw order stays the prefab's "z", never this point's."""
    def cell_at(self, point: Vec3 | Vec2) -> Cell | None:
        """The cell containing a world point (e.g. `ctx.input.pointer.world`), None if off-board."""
    def contains(self, cell: Cell) -> bool: ...
    def neighbors(self, cell: Cell, *, diagonal: bool = False) -> list[Cell]: ...
    def cells(self) -> Iterator[Cell]: ...
    def at(self, cell: Cell, *, tagged: TagFilter = (), having: Sequence[type[Any]] = ()) -> list[Entity]:
        """Entities on this grid whose GridCell is `cell` (indexed), filtered by tags and
        components."""
    def first_at(self, cell: Cell, *, tagged: TagFilter = (), having: Sequence[type[Any]] = ()) -> Entity | None: ...
    def parse(self, layout: Sequence[str]) -> dict[Cell, str]:
        """Text layout → {cell: char}. Text rows read like a map: the first row is the top
        (+z on the ground; +y on an "xy" board), rows run toward -z (-y), and columns run
        along +x — whichever `row_order` the grid uses."""
    def path(self, start: Cell, end: Cell, *, blocked: TagFilter = (), diagonal: bool = False) -> list[Cell]:
        """Shortest path avoiding cells that hold entities with a `blocked` tag."""

@component("grid_cell")
class GridCell(EngineComponent):
    """Places an entity on a grid. With `snap=True` the engine keeps the transform on
    the cell center; leave False to animate moves yourself."""
    grid: Entity | None = field(None)
    """None = the only Grid in the scene."""
    cell: Cell = field()
    snap: bool = field(False)


@component("grid_mover")
class GridMover(EngineComponent):
    """Moves a GridCell entity cell to cell at a steady speed (maze runners, snakes,
    tactics units): updates `cell` on arrival and tweens the transform between centers."""
    speed: float = field(4, unit="cells/s", modifiable=True)
    blocked: list[Tag] = field([])
    def step(self, direction: Cell) -> bool:
        """Start moving one cell; False if blocked or off-board. Queues one step if moving."""
    def go(self, direction: Cell) -> None:
        """Keep stepping in a direction until blocked or changed (Pac-style)."""
    def stop(self) -> None: ...
    @property
    def moving(self) -> bool: ...
    @property
    def direction(self) -> Cell | None: ...

@event("cell_entered", target="entity")
class CellEntered:
    entity: Entity
    cell: Cell
