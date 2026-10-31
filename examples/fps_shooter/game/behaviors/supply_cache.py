from parallax import Behavior, Color, ContentRef, behavior, on, param
from parallax.interaction import Interactable, Interacted
from project import Content, Text

from game.arena import give_ammo
from game.components import Arsenal
from game.content import AmmoGrant, WeaponDef


@behavior("supply_cache", requires=[Interactable])
class SupplyCache(Behavior):
    """A cover crate you can search once (hold E): a few spare rifle rounds, shown as a
    gold "+12 AMMO" over the crate."""

    weapon: ContentRef[WeaponDef] = param(Content.weapon.carbine)
    rounds: int = param(12, min=1)

    @on(Interacted)
    def searched(self, ctx, event):
        arsenal = event.source.try_get(Arsenal)
        if arsenal is None:
            return
        give_ammo(arsenal, [AmmoGrant(weapon=self.weapon, rounds=self.rounds)])
        ctx.ui.float_text(ctx.text(Text.ammo_found, rounds=self.rounds),
                          self.entity.transform.position + self.entity.get(Interactable).offset,
                          color=Color.hex("#e6ba70"))
