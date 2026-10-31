"""Panels, ported from the template's HTML/CSS (ui/kit.css is its kit: faces, --cp-*
tokens, .cp-* pieces): title, vault, HUD, relic draft, pause and the end-of-run screen.
Buttons are panel commands or plain functions owned by the system whose state they change."""

from parallax import Panel, Settings, close_panel, load_scene, open_panel, ui
from parallax.combat import Health
from project import Content, Placed, Scenes

from game.actions import Controls
from game.components import Foe, KeyFor, Room, ShopItem
from game.content import BoonDef
from game.resources import Outcome, Run, Vault
from game.rooms import room_at
from game.rules import Rules, current_floor
from game.systems.relic_draft import take_relic
from game.systems.run_flow import walk_out
from game.systems.vault_keeper import buy_boon


QUALITIES = ("low", "medium", "high")


def set_quality(ctx, quality: str) -> None:
    """The pause card's Graphics Low / Medium / High (the template's own settings view)."""
    if quality in QUALITIES:
        ctx.get(Settings).quality = quality


ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"]


def floor_line(ctx, run: Run) -> str:
    return f"Floor {run.floor + 1}/{len(ctx.config(Rules).floors)} · {ctx.text(current_floor(ctx).name)}"


def relic_names(ctx, run: Run) -> str:
    return ", ".join(ctx.text(relic.data.name) for relic in run.relics)


def hearts(health: Health) -> list[dict]:
    """One entry per heart container; health is counted in half-hearts."""
    return [
        {"full": health.current >= 2 * i + 2, "half": 2 * i + 1 <= health.current < 2 * i + 2}
        for i in range(int(health.max) // 2)
    ]


@ui("vault", html="ui/vault.html", modal=True, layer="menu")
class VaultPanel(Panel):
    actions = {"buy": buy_boon, "close": close_panel()}

    def state(self, ctx):
        vault = ctx.get(Vault)
        boons = []
        for boon in ctx.content(BoonDef):
            level = vault.levels.get(boon, 0)
            maxed = level == len(boon.data.costs)
            cost = 0 if maxed else boon.data.costs[level]
            top = len(boon.data.costs)
            boons.append({
                "boon": boon.id,
                "name": ctx.text(boon.data.name),
                "blurb": ctx.text(boon.data.blurb),
                "level_text": f"{level}/{top}" if top > 1 else "",
                "lvl": ("Owned" if maxed else "Unowned") if top == 1 else f"Lv {level}/{top}",
                "pips": [{"on": i < level} for i in range(top)],
                "price": ("Owned" if top == 1 else "Maxed") if maxed else str(cost),
                "maxed": maxed,
                "can_buy": not maxed and vault.coins >= cost,
                "poor": not maxed and vault.coins < cost,
                "unaffordable": maxed or vault.coins < cost,
            })
        return {"coins": vault.coins, "boons": boons}


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.cellar, new_run=True), "vault": open_panel(VaultPanel)}

    def state(self, ctx):
        vault = ctx.get(Vault)
        return {
            "vault_coins": f"{vault.coins}c",
            "deepest": f"{vault.best_floor}/{len(ctx.config(Rules).floors)}" if vault.runs else "—",
            "runs": vault.runs,
            "boss_kills": vault.boss_kills,
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu",
    scenes=[Scenes.cellar], toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "abandon": walk_out, "quality": set_quality}

    def state(self, ctx):
        quality = ctx.get(Settings).quality
        state = {f"quality_{q}": "true" if quality == q else "false" for q in QUALITIES}
        run = ctx.get(Run)
        numeral = ROMAN[run.floor + 1] if run.floor + 1 < len(ROMAN) else str(run.floor + 1)
        state["floor"] = f"Floor {numeral} · {ctx.text(current_floor(ctx).name)}"
        return state


ROOM_COLORS = {Content.room.boss: "#d33946", Content.room.shop: "#4cc9f0",
               Content.room.combat: "#f5c518", Content.room.start: "#4ade80"}


def floor_map(ctx, here) -> list[dict]:
    """The floor-plan minimap (the template's roomMap): rooms you've been in, filled in
    their kind's colour, and the rooms next to them as outlines, centred on this room."""
    rooms = list(ctx.world.query(Room))
    seen = {(r.cell_x, r.cell_y) for e, r in rooms if r.visited or (here is not None and here[0] == e)}
    near = {(x + dx, y + dy) for x, y in seen for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))}
    cx, cy = (here[1].cell_x, here[1].cell_y) if here else (0, 0)
    return [
        {
            "at": f"--x: {room.cell_x - cx}; --y: {room.cell_y - cy}; --kc: {ROOM_COLORS.get(room.kind, '#948272')}",
            "boss": room.kind == Content.room.boss,
            "shop": room.kind == Content.room.shop,
            "visited": (room.cell_x, room.cell_y) in seen,
            "here": here is not None and here[0] == entity,
        }
        for entity, room in rooms
        if (room.cell_x, room.cell_y) in seen or (room.cell_x, room.cell_y) in near
    ]


def floor_label(ctx, run) -> str:
    numeral = ROMAN[run.floor + 1] if run.floor + 1 < len(ROMAN) else str(run.floor + 1)
    return f"Floor {numeral} · {ctx.text(current_floor(ctx).name)}"


def objective(ctx, run, here) -> str:
    """The banner's room hint (the template's `_room_hint`): what this room asks of you."""
    name = ctx.text(current_floor(ctx).name)
    if run.outcome is Outcome.FELL:
        return "You fell in the dark."
    if run.outcome is Outcome.WON:
        return "The cellar is purged."
    rooms = ctx.world.query(Room)
    if any(room.kind == Content.room.boss and room.cleared for _, room in rooms):
        return "The way down is open — step on the pad."
    room = here[1] if here else None
    kind = room.kind if room else None
    if kind == Content.room.shop:
        stock = [f"{ctx.text(item.item.data.name)} {item.price}c" for _, item in ctx.world.query(ShopItem)]
        return "Shop: " + ", ".join(stock) if stock else "Shop — sold out"
    if kind == Content.room.boss:
        return f"{name} — its heart is down there."
    if kind == Content.room.gauntlet:
        return "The gauntlet. No way out but through."
    key_waiting = ctx.world.query(KeyFor).count() > 0
    if key_waiting and (kind == Content.room.start or (kind == Content.room.combat and room.cleared)):
        return f"{name} — a gate is locked: find the key."
    return f"{name} — clear it."


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        run = ctx.get(Run)
        keeper = ctx.world.placed(Placed.keeper)
        here = room_at(ctx, keeper.transform.position)
        boss = ctx.world.query(Foe, Health).where(lambda _, foe, health: foe.kind.data.boss).first()
        floors = len(ctx.config(Rules).floors)
        foes = ctx.world.query(Foe).count()
        return {
            "hearts": hearts(keeper.get(Health)),
            "coins": run.coins,
            "bombs": run.bombs,
            "keys": run.keys,
            "no_coins": run.coins == 0,
            "no_bombs": run.bombs == 0,
            "no_keys": run.keys == 0,
            "floor": f"{run.floor + 1}/{floors}",
            "floor_chip": f"F {run.floor + 1}/{floors}",
            "floor_name": ctx.text(current_floor(ctx).name),
            "fire_rate": f"{1 / max(0.01, run.fire_interval):.1f}/s",
            "shard_damage": f"{run.shard_damage:g}",
            "foes": foes,
            "has_objective": True,
            "objective": objective(ctx, run, here),
            "objective_label": floor_label(ctx, run),
            "objective_color": ROOM_COLORS.get(here[1].kind, "#f5c518") if here else "#f5c518",
            "map_on": True,
            "relics": [{"name": ctx.text(relic.data.name)} for relic in run.relics],
            "no_relics": not run.relics,
            "felled": run.outcome is Outcome.FELL,
            "purged": run.outcome is Outcome.WON,
            "rooms": floor_map(ctx, here),
            "boss": boss is not None,
            "boss_name": ctx.text(boss[1].kind.data.name) if boss else "",
            "boss_width": f"{(boss[2].fraction if boss else 0) * 100:.1f}%",
            "enraged": boss is not None and boss[2].fraction < 0.4,
        }


@ui("relic_draft", html="ui/draft.html", modal=True, layer="overlay",
    when=lambda ctx: bool(ctx.get(Run).draft))
class DraftPanel(Panel):
    actions = {"pick": take_relic}

    def state(self, ctx):
        return {
            "cards": [
                {"item": item.id, "number": n, "name": ctx.text(item.data.name), "blurb": ctx.text(item.data.blurb)}
                for n, item in enumerate(ctx.get(Run).draft, start=1)
            ],
        }


@ui("run_over", html="ui/run_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Run).outcome is not None)
class RunOverPanel(Panel):
    actions = {"again": load_scene(Scenes.cellar, new_run=True), "title": load_scene(Scenes.title, new_run=True)}

    def state(self, ctx):
        run = ctx.get(Run)
        won = run.outcome is Outcome.WON
        stat = lambda label, value: {"label": label, "value": str(value)}
        return {
            "won": won,
            "title": "PURGED" if won else "FELLED",
            "where": "You escaped the dark" if won else floor_line(ctx, run),
            "coins_banked": run.coins_banked,
            "stats": [
                stat("Floor", f"{run.floor + 1}/{len(ctx.config(Rules).floors)}"),
                stat("Relics", relic_names(ctx, run) or "None"),
                stat("In Vault", ctx.get(Vault).coins),
            ],
        }
