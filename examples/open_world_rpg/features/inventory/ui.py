"""The merchant's shop and the gear screen."""

from parallax import Context, ContentRef, Panel, close_panel, ui
from project import Text

from features.hero.feature import Progression
from features.inventory.actions import InventoryControls
from features.inventory.content import GearDef, Slot, WareDef
from features.inventory.gear import equip
from features.inventory.resources import Bag, Gear, Purse, Upgrades
from features.inventory.shop import buy, can_buy, price_of
from game.feed import Feed, Kind


@ui("shop", html="ui/shop.html", modal=True, layer="menu")
class ShopPanel(Panel):
    """Dunmore's stock, opened by his conversation. Locked wares show the level they open at; refines
    show how much each purchase raises the price."""

    actions = {"buy": buy, "close": close_panel()}

    def state(self, ctx):
        bought = [line for line in ctx.get(Feed).lines if line.kind is Kind.BOUGHT]
        return {
            "gold": ctx.get(Purse).gold,
            "last": ctx.text(Text.shop_last, ware=bought[-1].text) if bought else "",
            "wares": [self.ware_row(ctx, ware) for ware in ctx.content(WareDef)],
        }

    def ware_row(self, ctx: Context, ware: ContentRef[WareDef]) -> dict[str, object]:
        data = ware.data
        locked = ctx.get(Progression).level < data.min_level
        price = price_of(ctx, ware)
        short = max(0, price - ctx.get(Purse).gold)
        can = can_buy(ctx, ware)
        owned = ctx.get(Bag).items.get(data.item, 0) if data.item is not None else ctx.get(Upgrades).bought.get(ware, 0)
        icon, color = WARE_LOOK.get(ware.id, ("ward", "#d9bf80"))
        return {
            "ware": ware.id,
            "name": ctx.text(data.name),
            "desc": ctx.text(Text.ware_locked, level=data.min_level) if locked else ctx.text(data.description),
            "locked": locked,
            "min_level": data.min_level,
            "price": price,
            "step": ctx.text(Text.ware_step, step=data.price_step) if data.price_step else "",
            "owned": f"×{owned}" if owned else "",
            "can": can,
            "cannot": not can,
            "label": ctx.text(Text.shop_buy) if can else ctx.text(Text.shop_need_more, gold=short),
            "need_short": "" if can else ctx.text(Text.shop_need, gold=short),
            "color": color,
            **{name: name == icon for name in ("potion", "charm", "crystal", "blade", "oil", "ward")},
        }


# The template shop's icon and tint per ware.
WARE_LOOK = {
    "health_potion": ("potion", "#e78867"), "mana_potion": ("potion", "#7dd8dc"), "vigor_charm": ("charm", "#e78867"),
    "focus_crystal": ("crystal", "#7dd8dc"), "rune_whetstone": ("blade", "#e0c48c"), "swiftblade_oil": ("oil", "#e0c48c"),
    "wardstone": ("ward", "#d9bf80"),
}


@ui("gear", html="ui/gear.html", modal=True, layer="menu", toggle_with=InventoryControls.gear)
class GearPanel(Panel):
    """Each slot's worn piece and the spares found for it, the worn totals, and the damage kind the
    sword swings (an elemental weapon's element, else physical)."""

    actions = {"equip": equip, "close": close_panel()}

    def state(self, ctx):
        gear = ctx.get(Gear)
        worn = [piece.data for piece in gear.worn.values()]
        element = next((p.element for p in worn if p.element is not None), None)
        totals = [
            {"label": ctx.text(label), "value": f"+{amount:g}"}
            for label, amount in ((Text.stat_damage, sum(p.damage for p in worn)),
                                  (Text.stat_attack_rate, sum(p.attack_rate for p in worn)),
                                  (Text.stat_defense, sum(p.defense for p in worn)),
                                  (Text.stat_max_health, sum(p.max_health for p in worn)),
                                  (Text.stat_max_mana, sum(p.max_mana for p in worn)))
            if amount
        ]
        return {
            "element": element.id.capitalize() if element is not None else ctx.text(Text.physical),
            "slots": [self.slot_row(ctx, slot) for slot in Slot],
            "totals": totals,
        }

    def slot_row(self, ctx: Context, slot: Slot) -> dict[str, object]:
        gear = ctx.get(Gear)
        worn = gear.worn.get(slot)
        return {
            "name": ctx.text(SLOT_NAMES[slot]),
            "worn": self.piece_row(ctx, worn) if worn is not None else None,
            "spares": [self.piece_row(ctx, piece) for piece in gear.owned if piece.data.slot is slot and piece != worn],
        }

    def piece_row(self, ctx: Context, piece: ContentRef[GearDef]) -> dict[str, object]:
        data = piece.data
        stats = (
            (data.damage, Text.stat_damage), (data.attack_rate, Text.stat_attack_rate),
            (data.defense, Text.stat_defense), (data.max_health, Text.stat_max_health),
            (data.max_mana, Text.stat_max_mana),
        )
        chips = [{"text": f"+{amount:g} {ctx.text(label)}"} for amount, label in stats if amount]
        if data.element is not None:
            kind = data.element.id
            chips.append({"text": ctx.text(Text.gear_edge, element=kind.capitalize()),
                          "fire": kind == "fire", "frost": kind == "frost", "arcane": kind == "arcane"})
        return {"piece": piece.id, "name": ctx.text(data.name), "chips": chips}


SLOT_NAMES = {Slot.WEAPON: Text.slot_weapon, Slot.ARMOR: Text.slot_armor, Slot.CHARM: Text.slot_charm}
