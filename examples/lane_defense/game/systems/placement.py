"""Picking a cell and using the armed tool on it."""

import math

from parallax import SceneLoaded, System, on, system, vec3
from parallax.grid import Cell, GridCell
from project import Assets, Prefabs, Scenes, Text

from game.actions import GardenControls
from game.components import Planted, PollenMote
from game.config import GardenRules
from game.lawn import PLANT_Y, SPAWN_TURN, current_level, lane_z, lawn
from game.notes import say
from game.resources import Irrigation, Planting, Pollen, Tool
from game.audio import Sounds, play


@system("placement", scenes=[Scenes.garden])
class Placement(System):
    """Tracks the hovered cell (pointer, or the keyboard/gamepad cursor) and, on
    confirm, plants the armed seed, digs up a plant for a partial refund, or waters a
    row. Rows the level keeps closed get a resting-soil strip."""

    @on(SceneLoaded)
    def rest_closed_rows(self, ctx, event):
        lanes = current_level(ctx).lanes
        for row in range(lawn(ctx).rows):
            if row not in lanes:
                ctx.world.spawn(Prefabs.resting_row, at=vec3(0, 0.11, lane_z(ctx, row)))
        ctx.get(Planting).cursor = Cell(1, lanes[0])

    def update(self, ctx, dt):
        planting = ctx.get(Planting)
        self.track_hover(ctx, planting)
        if planting.tool is not Tool.NONE and planting.hover is not None and ctx.input.pressed(GardenControls.confirm) \
                and not self.collecting_a_mote(ctx):
            self.use_tool(ctx, planting, planting.hover)

    def collecting_a_mote(self, ctx) -> bool:
        """A click on a mote collects it; it also presses `confirm`, which must not plant."""
        pointer = ctx.input.pointer
        return pointer.pressed and pointer.over is not None and pointer.over.has(PollenMote)

    def track_hover(self, ctx, planting):
        grid = lawn(ctx)
        flick = ctx.input.pressed_direction(GardenControls.cursor)
        if flick is not None:
            # Screen up (+y) is the row above; row 0 is the top row (row_order "down").
            # (`pressed_step` says this directly in the SDK, but the Python API doesn't expose it yet.)
            step = Cell(round(flick.x), -round(flick.y))
            # As the template: columns clamp to the board, rows step through open lanes only.
            planting.cursor_active = True
            lanes = current_level(ctx).lanes
            at = lanes.index(planting.cursor.row) if planting.cursor.row in lanes else 0
            row = lanes[max(0, min(len(lanes) - 1, at + step.row))]
            planting.cursor = Cell(max(0, min(grid.cols - 1, planting.cursor.col + step.col)), row)
        elif ctx.input.pointer.moved:
            planting.cursor_active = False
        planting.hover = planting.cursor if planting.cursor_active else grid.cell_at(ctx.input.pointer.world)

    def use_tool(self, ctx, planting, cell: Cell):
        if cell.row not in current_level(ctx).lanes:
            say(ctx, ctx.text(Text.notice_row_resting))
            return
        rules = ctx.config(GardenRules)
        occupant = lawn(ctx).first_at(cell)
        if planting.tool is Tool.WATER:
            irrigation = ctx.get(Irrigation)
            irrigation.row = cell.row
            irrigation.ready_at = ctx.time.now + rules.water_cooldown
            say(ctx, ctx.text(Text.notice_row_watered, row=cell.row + 1))
            play(ctx, ctx.config(Sounds).water)
            planting.tool = Tool.NONE
            return
        elif planting.tool is Tool.DIG:
            if occupant is None:
                say(ctx, ctx.text(Text.notice_choose_dig))
                return
            ctx.get(Pollen).amount += math.floor(occupant.get(Planted).kind.data.cost * rules.dig_refund)
            occupant.destroy()
        elif occupant is not None:
            say(ctx, ctx.text(Text.notice_cell_taken))
            return
        elif not self.plant_seed(ctx, planting, cell):
            return
        planting.tool = Tool.NONE
        ctx.vfx.play(Assets.vfx.soil_puff, at=lawn(ctx).center(cell).with_y(0.15))
        play(ctx, ctx.config(Sounds).plant)  # the planting cue plays for the trowel too

    def plant_seed(self, ctx, planting, cell: Cell) -> bool:
        seed, pollen = planting.seed, ctx.get(Pollen)
        if pollen.amount < seed.data.cost or ctx.time.now < planting.seed_ready_at.get(seed, 0):
            say(ctx, ctx.text(Text.notice_seed_not_ready))
            return False
        pollen.amount -= seed.data.cost
        planting.seed_ready_at[seed] = ctx.time.now + seed.data.recharge
        ctx.world.spawn(
            seed.data.prefab,
            at=lawn(ctx).center(cell).with_y(PLANT_Y),
            rotation=SPAWN_TURN,
            components=[Planted(kind=seed), GridCell(cell=cell, snap=True)],
        )
        return True
