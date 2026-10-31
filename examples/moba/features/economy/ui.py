from parallax import ContentRef, Panel, close_panel, ui
from project import Text

from features.economy.components import Items, Wallet
from features.economy.rpcs import buy_item
from features.economy.shop import quote
from game.actions import Controls
from game.config import MatchRules
from game.content import ItemCategory, ItemDef, StatBlock
from game.svg import path_image
from game.viewer import my_hero

CATEGORY_LOOK = {
    ItemCategory.ATTACK: ("#e8835a", "M13 1 L17 15 L13 25 L9 15 Z"),
    ItemCategory.GUARD: ("#5fb8a6", "M4 3 H22 V12 C22 18 18 22 13 24 C8 22 4 18 4 12 Z"),
    ItemCategory.RELIC: ("#e2b84a", "M13 2 L23 13 L13 24 L3 13 Z"),
    ItemCategory.SWIFT: ("#86c95a", "M3 5 L11 13 L3 21 L7 21 L15 13 L7 5 Z M11 5 L19 13 L11 21 L15 21 L23 13 L15 5 Z"),
    ItemCategory.ARCANE: ("#a283f0", "M13 2 L15.5 10.5 L24 13 L15.5 15.5 L13 24 L10.5 15.5 L2 13 L10.5 10.5 Z"),
}
"""Each category's colour and glyph (the template's shop)."""

CATEGORY_NAME = {
    ItemCategory.ATTACK: Text.cat_attack, ItemCategory.ARCANE: Text.cat_arcane, ItemCategory.GUARD: Text.cat_guard,
    ItemCategory.SWIFT: Text.cat_swift, ItemCategory.RELIC: Text.cat_relic,
}
TIER_NAME = {1: Text.tier_starter, 2: Text.tier_upgrade}
def stat_lines(ctx, stats: StatBlock) -> list[dict]:
    """A stat block as the shop prints it ("+40 Attack Damage", "+12% Attack Speed")."""
    flat = [
        (stats.max_health, Text.stat_max_health), (stats.max_mana, Text.stat_max_mana),
        (stats.mana_regen, Text.stat_mana_regen), (stats.damage, Text.stat_damage),
        (stats.ability_power, Text.stat_ability_power), (stats.attack_range, Text.stat_attack_range),
        (stats.move_speed, Text.stat_move_speed), (stats.dash_bonus, Text.stat_dash_bonus),
    ]
    lines = []
    for amount, label in flat:
        if amount:
            shown = int(amount) if amount == int(amount) else round(amount, 2)
            lines.append({"text": f"{'+' if amount > 0 else ''}{shown} {ctx.text(label)}"})
    if stats.attack_interval:
        lines.append({"text": f"{round(-stats.attack_interval * 100):+d}% {ctx.text(Text.stat_attack_speed)}"})
    if stats.damage_reduction:
        lines.append({"text": f"{round(stats.damage_reduction * 100):+d}% {ctx.text(Text.stat_damage_reduction)}"})
    return lines


@ui("shop", html="ui/shop.html", modal=True, toggle_with=Controls.shop)
class ShopPanel(Panel):
    """The item shop. Prices already subtract components you own. In a networked
    game a modal never pauses, so the match keeps running behind it. Buying calls
    the server directly."""

    actions = {"buy": buy_item, "close": close_panel()}

    def state(self, ctx):
        hero = my_hero(ctx)
        gold = hero.get(Wallet).gold
        owned = hero.get(Items).owned
        catalog = sorted(ctx.content(ItemDef), key=lambda i: (i.data.tier, i.data.cost))
        cards = [self._card(ctx, item, owned, gold) for item in catalog]
        slots = ctx.config(MatchRules).item_slots
        names = " · ".join(ctx.text(i.data.name) for i in owned)
        state = {
            "balance": ctx.text(Text.shop_balance, amount=f"{gold:,}"),
            "items": cards,
            "count_all": len(catalog),
            "slots": [self._slot(owned[k] if k < len(owned) else None) for k in range(slots)],
            "inventory": ctx.text(Text.shop_inventory, used=len(owned), slots=slots) + (f" — {names}" if names else ""),
        }
        for category in ItemCategory:
            state[f"count_{category.value}"] = sum(1 for i in catalog if i.data.category is category)
        return state

    def _card(self, ctx, item: ContentRef[ItemDef], owned: list[ContentRef[ItemDef]], gold: int) -> dict:
        data = item.data
        price = quote(item, owned).price
        color, glyph = CATEGORY_LOOK[data.category]
        kind = ctx.text(CATEGORY_NAME[data.category])
        if data.tier in TIER_NAME:
            kind += f" · {ctx.text(TIER_NAME[data.tier])}"
        card = {
            "item": item.id,
            "name": ctx.text(data.name),
            "blurb": ctx.text(data.blurb),
            "kind": kind,
            "color": color,
            "glyph_img": path_image("0 0 26 26", glyph, color),
            "price_text": f"{price:,}",
            "cost_text": f"{data.cost:,}" if price < data.cost else "",
            "stat_lines": stat_lines(ctx, data.stats),
            "builds_from": [{"name": ctx.text(part.data.name), "own": part in owned} for part in data.builds_from],
            "too_expensive": price > gold,
            "buy_label": ctx.text(Text.shop_buy, amount=f"{price:,}") if price <= gold
                         else ctx.text(Text.shop_need, amount=f"{price - gold:,}"),
        }
        for category in ItemCategory:
            card[f"is_{category.value}"] = data.category is category
        return card

    def _slot(self, item: ContentRef[ItemDef] | None) -> dict:
        if item is None:
            return {"full": False, "glyph_img": ""}
        color, glyph = CATEGORY_LOOK[item.data.category]
        return {"full": True, "glyph_img": path_image("0 0 26 26", glyph, color)}
