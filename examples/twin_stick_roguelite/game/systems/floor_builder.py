import random

from parallax import Shape, System, system, vec3
from parallax.values import Cell
from project import Prefabs, Scenes

from game.components import Gate, KeyFor, Room, ShopItem
from game.content import RoomKindDef
from game.floor_plan import STEPS, FloorPlan, plan_floor
from game.resources import Run
from game.rooms import room_center
from game.rules import Rules, current_floor


@system("floor_builder", scenes=[Scenes.cellar])
class FloorBuilder(System):
    """Builds a fresh floor each time the cellar scene loads: room slabs, walls with door
    gaps, gates, a key per lock, braziers, locked chests and the shop's pedestals."""

    def start(self, ctx):
        rules = ctx.config(Rules)
        floor = current_floor(ctx)
        plan = plan_floor(floor.rooms, rules.grid_radius, floor.loops, floor.has_gauntlet, floor.locks)
        kinds = ctx.content(RoomKindDef)
        rooms = {cell: self.spawn_room(ctx, rules, cell, kinds.get(kind), floor) for cell, kind in plan.kinds.items()}
        for cell in plan.kinds:
            self.spawn_walls(ctx, rules, plan, cell)
        for a, b in (tuple(pair) for pair in plan.links):
            self.spawn_gate(ctx, rules, plan, a, b, rooms)
        for lock, cell in plan.keys.items():
            key = ctx.world.spawn(Prefabs.gate_key, at=room_center(rules, cell), components=[KeyFor(lock=lock)])
            key.get(Shape).color = rules.lock_colors[lock % len(rules.lock_colors)]
        self.place_chests(ctx, rules, plan, floor.locked_chests)
        self.dress(ctx, rules, plan)
        for cell, kind in plan.kinds.items():
            if kind == "shop":
                self.stock_shop(ctx, rules, cell, floor)

    def dress(self, ctx, rules, plan: FloorPlan):
        """A brazier in every corner; the entry hall keeps two breakables to teach the
        shoot-it-for-loot loop before the first fight."""
        reach = rules.room_size / 2 - rules.brazier_inset
        for cell in plan.kinds:
            for sx in (-1, 1):
                for sz in (-1, 1):
                    ctx.world.spawn(Prefabs.brazier, at=room_center(rules, cell) + vec3(sx * reach, 0, sz * reach))
        ctx.world.spawn(Prefabs.barrel, at=vec3(-4, 0, 3))
        ctx.world.spawn(Prefabs.crate, at=vec3(4.5, 0, 3.5))

    def spawn_room(self, ctx, rules, cell: Cell, kind, floor):
        room = ctx.world.spawn(Prefabs.room_floor, at=room_center(rules, cell),
                               components=[Room(kind=kind, cell_x=cell.col, cell_y=cell.row)])
        room.get(Shape).color = kind.data.color.lerp(floor.tint, rules.floor_tint_strength)
        return room

    def spawn_walls(self, ctx, rules, plan: FloorPlan, cell: Cell):
        """Each room builds its +x/+z walls, and its -x/-z walls only where no room is."""
        half = rules.room_size / 2
        for direction in STEPS:
            neighbour = cell + direction
            if neighbour in plan.kinds and (direction.col < 0 or direction.row < 0):
                continue
            middle = room_center(rules, cell) + vec3(direction.col, 0, direction.row) * half
            along = vec3(0, 0, 1) if direction.col else vec3(1, 0, 0)
            if plan.linked(cell, neighbour):
                stub = (rules.room_size - rules.door_width) / 2
                for side in (-1, 1):
                    self.wall(ctx, middle + along * (side * (rules.door_width + stub) / 2), along, stub)
            else:
                self.wall(ctx, middle, along, rules.room_size)

    def wall(self, ctx, at, along, length):
        ctx.world.spawn(Prefabs.wall, at=at, rotation=vec3(0, 90 if along.z else 0, 0), scale=vec3(length, 1, 1))

    def spawn_gate(self, ctx, rules, plan: FloorPlan, a: Cell, b: Cell, rooms):
        at = (room_center(rules, a) + room_center(rules, b)) / 2
        across_x = a.col != b.col
        lock = plan.lock_of(a, b)
        ctx.world.spawn(Prefabs.gate, at=at, rotation=vec3(0, 90 if across_x else 0, 0),
                        components=[Gate(between=[rooms[a], rooms[b]], locked=lock is not None,
                                         lock=-1 if lock is None else lock)])

    def place_chests(self, ctx, rules, plan: FloorPlan, count: int):
        combat = [cell for cell, kind in plan.kinds.items() if kind == "combat" and cell not in plan.keys.values()]
        for cell in random.sample(combat, min(count, len(combat))):
            # The floor plan keeps the template's coordinates (not mirrored across z), so its
            # yaw 0 for a model facing the old -z forward is a half turn here (models face +z).
            ctx.world.spawn(Prefabs.locked_chest, at=room_center(rules, cell) + vec3(rules.chest_offset, 0, 0),
                            rotation=vec3(0, 180, 0))

    def stock_shop(self, ctx, rules, cell: Cell, floor):
        """Each pedestal draws one offer for its slot from the rows allowed on this floor."""
        this_floor = rules.floors[ctx.get(Run).floor]
        rows = [row for row in rules.shop_stock if this_floor in row.floors]
        slots = sorted({row.slot for row in rows})
        for index, slot in enumerate(slots):
            row = random.choice([row for row in rows if row.slot == slot])
            offset = (index - (len(slots) - 1) / 2) * rules.shop_spacing
            ctx.world.spawn(Prefabs.pedestal, at=room_center(rules, cell) + vec3(offset, 0, 0),
                            components=[ShopItem(item=row.item, price=round(row.price * floor.shop_price_mult))])
