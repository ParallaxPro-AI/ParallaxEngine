import random

from parallax import Context, ContentRef, System, on, system
from project import Scenes, Text

from game.content import ItemDef
from game.events import FloorBossCleared, ItemCollected
from game.resources import Run
from game.rules import Rules


@system("relic_draft", scenes=[Scenes.cellar])
class RelicDraft(System):
    """After each floor's boss: pick one of three relics to carry down. The draft panel
    is open while an offer is on the table and is modal, so the floor freezes and the
    exit pad can't be reached until you choose (`take_relic`)."""

    @on(FloorBossCleared)
    def offer(self, ctx, event: FloorBossCleared):
        relics = [item for item in ctx.content(ItemDef) if item.data.relic]
        ctx.get(Run).draft = random.sample(relics, min(ctx.config(Rules).draft_size, len(relics)))


def take_relic(ctx: Context, item: ContentRef[ItemDef]) -> None:
    """The draft panel's card action: the clicked relic is yours, the rest are gone."""
    run = ctx.get(Run)
    if item not in run.draft:
        return
    run.draft = []
    ctx.ui.toast(Text.relic_taken)
    ctx.emit(ItemCollected(item=item))
