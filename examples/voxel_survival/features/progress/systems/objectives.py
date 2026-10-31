from parallax import ContentRef, System, on, system
from parallax.voxels import BlockChanged

from features.creatures.feature import BeaconHeld
from features.inventory.feature import ItemCrafted, ItemStored
from features.progress.resources import Lifetime, Progress
from features.survival.feature import HomeSet
from features.world.feature import Harvested
from game.content import ItemDef, ObjectiveDef, Trigger


@system("objectives")
class Objectives(System):
    """Ticks off the homestead objectives (content/objective/) as the player hits
    each milestone, and keeps the lifetime blocks-mined count."""

    def update(self, ctx, dt):
        """The first night is survived once the environment's day count moves on
        (at midnight, or by sleeping through it)."""
        if ctx.environment.day > 0:
            self._reached(ctx, Trigger.NIGHT_SURVIVED)

    @on(BlockChanged, where=lambda event: event.source is not None)
    def block_changed(self, ctx, event: BlockChanged):
        """Only edits the player made count: growth, doors and saved edits have no `source`."""
        if event.new is not None:
            self._reached(ctx, Trigger.PLACED)
            return
        ctx.get(Lifetime).blocks_mined += 1
        self._reached(ctx, Trigger.MINED)
        if event.old.data.ore:
            self._reached(ctx, Trigger.MINED_ORE)

    @on(ItemCrafted)
    def crafted(self, ctx, event: ItemCrafted):
        self._reached(ctx, Trigger.CRAFTED, event.item)
        if event.item.data.tool:
            self._reached(ctx, Trigger.CRAFTED_TOOL)

    @on(ItemStored)
    def stored(self, ctx, event: ItemStored):
        self._reached(ctx, Trigger.STORED)

    @on(HomeSet)
    def home_set(self, ctx, event: HomeSet):
        self._reached(ctx, Trigger.HOME_SET)

    @on(Harvested)
    def harvested(self, ctx, event: Harvested):
        self._reached(ctx, Trigger.HARVESTED)

    @on(BeaconHeld)
    def beacon_held(self, ctx, event: BeaconHeld):
        self._reached(ctx, Trigger.BEACON_HELD)

    def _reached(self, ctx, trigger: Trigger, item: ContentRef[ItemDef] | None = None):
        progress = ctx.get(Progress)
        reached = [o for o in ctx.content(ObjectiveDef)
                   if o.data.trigger is trigger and o.data.item in (None, item) and o not in progress.done]
        if reached:
            progress.done = progress.done + reached
