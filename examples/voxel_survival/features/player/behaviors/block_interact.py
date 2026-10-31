from parallax import Behavior, Vec3, behavior, param, state
from parallax.combat import Health
from parallax.voxels import BlockHit
from project import Text

from game.audio import Sounds
from features.inventory.feature import Equipment, selected
from features.player.components import Aim
from features.world.feature import BreakRequested, PlaceRequested
from game.actions import Controls
from game.components import Creature, Usable
from game.content import ItemDef, ToolKind
from game.events import Used


@behavior("block_interact", requires=[Aim, Equipment])
class BlockInteract(Behavior):
    """What the player does to the thing under the crosshair. Holding mine swings
    at a creature in front, or else digs the block; place and use act on press.
    This behavior only aims and times; the world feature decides what a broken
    or placed block actually does."""

    seconds_per_hardness: float = param(0.45, unit="s", doc="Bare-handed time to break one point of hardness.")
    min_mine_time: float = param(0.08, unit="s", doc="Floor on a block's bare-handed breaking time.")
    attack_range: float = param(3.4, unit="m")
    swing_cooldown: float = param(0.42, unit="s")
    next_swing: float = state(0.0)

    def update(self, ctx, dt):
        aim = self.entity.get(Aim)
        tool = self.entity.get(Equipment).tool.data
        origin, direction = ctx.camera.main.ray()
        hit = ctx.voxels.raycast(origin, direction, tool.reach)
        self._aim(aim, hit)

        if ctx.input.held(Controls.mine):
            if not self._swing(ctx, origin, direction, tool):
                self._dig(ctx, dt, aim, hit, tool)
        else:
            aim.progress = 0
        if ctx.input.pressed(Controls.place) and aim.place_cell:
            ctx.emit(PlaceRequested(cell=aim.place_cell, by=self.entity))
        if ctx.input.pressed(Controls.use):
            self._use(ctx, origin, direction, tool, hit)

    def _aim(self, aim: Aim, hit: BlockHit | None):
        if hit is None or hit.cell != aim.cell:
            aim.progress = 0
            aim.too_weak_for = None
        aim.cell = hit.cell if hit else None
        item = selected(self.entity).item
        aim.place_cell = hit.place_cell if hit and item and item.data.places else None

    def _swing(self, ctx, origin: Vec3, direction: Vec3, tool: ItemDef) -> bool:
        """Hit the creature in front, if there is one and no wall is in the way."""
        hit = ctx.physics.raycast(origin, direction, self.attack_range, ignore=[self.entity])
        if hit is None or hit.entity is None or not hit.entity.has(Creature) or ctx.voxels.raycast(origin, direction, hit.distance):
            return False
        if ctx.time.now >= self.next_swing:
            self.next_swing = ctx.time.now + self.swing_cooldown
            hit.entity.get(Health).damage(tool.damage, source=self.entity, point=hit.point)
            ctx.audio.play(ctx.config(Sounds).hit, at=hit.point, volume=0.3)
        return True

    def _dig(self, ctx, dt, aim: Aim, hit: BlockHit | None, tool: ItemDef):
        if hit is None:
            return
        block = hit.block.data
        if block.unbreakable:
            return
        if block.min_tier > tool.tier or (block.min_tier > 0 and tool.tool is not ToolKind.PICKAXE):
            aim.too_weak_for = hit.block
            return
        power = tool.mine_speed if tool.tool is block.preferred_tool else 1
        aim.progress += dt * power / max(self.min_mine_time, block.hardness * self.seconds_per_hardness)
        if aim.progress >= 1:
            aim.progress = 0
            ctx.emit(BreakRequested(cell=hit.cell, by=self.entity))

    def _use(self, ctx, origin: Vec3, direction: Vec3, tool: ItemDef, hit: BlockHit | None):
        """Use a usable entity in front (a grave), else the block entity under the crosshair."""
        touched = ctx.physics.raycast(origin, direction, tool.reach, ignore=[self.entity])
        target = touched.entity if touched and touched.entity.has(Usable) else None
        if target is None and hit:
            target = ctx.voxels.block_entity(hit.cell)
        if target is None:
            ctx.ui.toast(Text.use_hint)
            return
        ctx.emit(Used(entity=target, by=self.entity))
