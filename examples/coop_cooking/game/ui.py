"""Panels, ported from the template's HTML/CSS (ui/kitchen_kit.css holds its fonts, tokens
and shared classes): the service strip and the order rail across both halves, a card and
a wayfinding overlay in each chef's half, and the title, pause and receipt menus. The
template's PP_ON_STATE scripts became bindings; only the pause card keeps a script (its
Settings / Back views)."""

import math

from parallax import (
    Camera, Color, Context, Entity, Panel, PlayerPanel, Settings, Vec3, close_panel, open_panel, ui, vec3,
)
from project import Text

from game.actions import ChefControls
from game.components import Chef, Pot, PotState, Station
from game.content import Item, ServiceRules
from game.recipes import Act, plan, station_in_reach
from game.resources import Orders, Record, Result, Service, cooking
from game.rules import kitchen, time_left
from game.systems.guide import wanted

# The key caps each seat's card prints (the bindings in game/actions.py).
SEAT_KEYS = [
    {"key_up": "W", "key_left": "A", "key_down": "S", "key_right": "D", "key_use": "E"},
    {"key_up": "I", "key_left": "J", "key_down": "K", "key_right": "L", "key_use": "O"},
]
QUALITIES = ("low", "medium", "high")
QUALITY_TEXT = {"low": Text.quality_low, "medium": Text.quality_medium, "high": Text.quality_high}
PIN_LIFT = 1.7                 # meters above a station's origin its pin hangs from
PIN_BAND = (0.25, 0.76)        # the part of the half pins may use (clear of the banner and the rail)
EDGE_BAND = (0.24, 0.72)
CHIP_LIFT = 2.6                # the carrying pill over the chef


def held_color(item: Item | None, item_id: str) -> str:
    """The ingredient dot for what a chef holds (the template's heldColor)."""
    if item is None:
        return "transparent"
    if item_id == "burnt_food":
        return "var(--kr-burnt)"
    for part, token in (("deluxe", "mustard"), ("salad", "st-lettuce"), ("lettuce", "st-lettuce"),
                        ("onion", "st-onion"), ("tomato", "st-tomato")):
        if part in item_id:
            return f"var(--kr-{token})"
    return "var(--kr-st-bin)"


def css(color: Color) -> str:
    return f"rgb({round(color.r * 255)}, {round(color.g * 255)}, {round(color.b * 255)})"


def short_name(name: str) -> str:
    """The Diner → Diner (the title's stops, the receipt's pills)."""
    return name[4:] if name.startswith("The ") else name


def bar_band(left: float) -> dict:
    return {"ok": left > 0.5, "warn": 0.2 <= left <= 0.5, "bad": left < 0.2}


def pct(fraction: float) -> str:
    return f"{max(0.0, min(1.0, fraction)) * 100:.1f}%"


def play_again(ctx: Context) -> None:
    """A new campaign from the first kitchen in the config, straight into service."""
    first = ctx.config(ServiceRules).kitchens[0].data
    ctx.scenes.load(first.scene, new_run=True, init=[Service(opened=True)])


def main_menu(ctx: Context) -> None:
    """Back to the title over the first kitchen; the campaign starts over."""
    first = ctx.config(ServiceRules).kitchens[0].data
    ctx.scenes.load(first.scene, new_run=True)


def open_kitchen(ctx: Context) -> None:
    """The title's button: the doors open and the clock starts."""
    ctx.get(Service).opened = True


def set_quality(ctx: Context, quality: str) -> None:
    """The pause card's Graphics Low / Medium / High."""
    if quality in QUALITIES:
        ctx.get(Settings).quality = quality


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", toggle_with=ChefControls.pause)
class PauseMenu(Panel):
    """The kitchen and its seconds left, Resume / Settings / Main Menu."""

    actions = {"resume": close_panel(), "quality": set_quality, "main_menu": main_menu}

    def state(self, ctx):
        quality = ctx.get(Settings).quality
        return {
            "where": ctx.text(Text.pause_where, kitchen=ctx.text(kitchen(ctx).name),
                              seconds=max(0, math.ceil(time_left(ctx)))),
            "quality_desc": ctx.text(QUALITY_TEXT.get(quality, Text.quality_medium)),
            "quality_low": "true" if quality == "low" else "false",
            "quality_medium": "true" if quality == "medium" else "false",
            "quality_high": "true" if quality == "high" else "false",
        }


def in_service(ctx: Context) -> bool:
    """The service HUD shows while cooking and hides under the pause card, as the
    template's `paused` state did."""
    return cooking(ctx) and not ctx.ui.is_open(PauseMenu)


@ui("kitchen_top", html="ui/kitchen_top.html", when=in_service)
class KitchenTop(Panel):
    """Across both halves: the round clock hanging from the top edge, the team score
    against this kitchen's target (amber while short, green once banked), the divider."""

    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        service, today, rules = ctx.get(Service), kitchen(ctx), ctx.config(ServiceRules)
        left = time_left(ctx)
        total = sum(service.scores)
        return {
            "kitchen": ctx.text(today.name),
            "number": ctx.text(Text.kitchen_number, n=service.kitchen + 1, total=len(rules.kitchens)),
            "seconds": max(0, math.ceil(left)),
            "warn": left <= rules.clock_warning,
            "score": total,
            "target": ctx.text(Text.of_target, target=today.target),
            "fill": pct(total / today.target if today.target > 0 else 1),
            "banked": total >= today.target,
        }


@ui("kitchen_orders", html="ui/kitchen_orders.html", when=in_service)
class KitchenOrders(Panel):
    """The order rail: each ticket's number, payout, recipe dots and line, time left; the
    pots on the heat; the combo pill and the rail's Missed! flash."""

    def state(self, ctx):
        service = ctx.get(Service)
        pots = [pot for _, pot in ctx.world.query(Pot) if pot.state is not PotState.EMPTY]
        return {
            "on_streak": service.streak >= 2,
            "streak": ctx.text(Text.streak, streak=service.streak),
            "missed": ctx.time.now - service.missed_at < 2.4,
            "tickets": [ticket_view(ctx, ticket) for ticket in ctx.get(Orders).tickets],
            "has_pots": len(pots) > 0,
            "pots": [pot_view(ctx, pot) for pot in pots],
        }


def ticket_view(ctx: Context, ticket) -> dict:
    dish = ticket.dish.data
    left = max(0.0, ticket.time_left / ticket.lifetime)
    return {
        "number": f"#{ticket.number:03d}",
        "points": f"+{dish.points}",
        "dish": ctx.text(dish.name),
        "method": ctx.text(dish.method),
        "dots": [{"color": f"var(--kr-st-{item.id})"} for item in dish.ingredients],
        "fill": pct(left),
        "seconds": f"{max(0, math.ceil(ticket.time_left))}s",
        "urgent": left < 0.2,
        **bar_band(left),
    }


def pot_view(ctx: Context, pot: Pot) -> dict:
    name = ctx.text(pot.contents.data.name)
    if pot.state is PotState.BURNT:
        return {"cooking": False, "ready": False, "burnt": True, "verb": "", "label": ctx.text(Text.pot_burnt), "fill": "0%"}
    if pot.state is PotState.READY:
        return {"cooking": False, "ready": True, "burnt": False, "verb": "",
                "label": ctx.text(Text.pot_ready, dish=name), "fill": pct(pot.time_left / max(0.01, pot.burn_seconds))}
    return {"cooking": True, "ready": False, "burnt": False, "verb": ctx.text(Text.cooking_verb) + " ",
            "label": name, "fill": pct(1 - pot.time_left / max(0.01, pot.cook_seconds))}


@ui("chef_card", html="ui/chef_card.html", when=in_service)
class ChefCard(PlayerPanel):
    """One per seat, in that chef's half: the card (holding, score), what the station in
    front of them would do, and the step banner with the feedback chip."""

    def state(self, ctx, player):
        chef = player.entity
        hands = chef.get(Chef)
        held = hands.held
        station = station_in_reach(ctx, chef)
        action = plan(station, held) if station is not None else None
        item = held.data if held is not None else None
        prompt = ""
        if action is not None:
            prompt = ctx.text(action.prompt, seconds=action.seconds,
                              item=ctx.text(action.item.data.name) if action.item is not None else "")
        said_live = hands.said_count > 0
        return {
            **SEAT_KEYS[player.index % len(SEAT_KEYS)],
            "p1": player.index == 0,
            "p2": player.index != 0,
            "player": ctx.text(Text.player_n, n=player.index + 1),
            "side": ctx.text(Text.left if player.index == 0 else Text.right),
            "holding": held.id.replace("_", " ") if held is not None else ctx.text(Text.empty_hands),
            "empty": held is None,
            "held_color": held_color(item, held.id if held is not None else ""),
            "score": ctx.get(Service).scores[player.index],
            "has_prompt": action is not None,
            "idle": action is not None and action.act is Act.WAIT,
            "prompt": prompt,
            "step": ctx.text(Text.step_number, n=item.stage if item is not None else 1),
            "task": ctx.text(item.task) if item is not None else ctx.text(Text.grab_something),
            "hint": ctx.text(item.hint) if item is not None else ctx.text(Text.grab_hint),
            "burnt": held is not None and held == ctx.config(ServiceRules).burnt,
            "said": ("✕ " if hands.said_bad else "✓ ") + hands.said.replace("-", "−") if said_live else "",
            "said_ok": not hands.said_bad,
            "said_bad": hands.said_bad,
            "go": said_live and hands.said_count % 2 == 1,
            "go2": said_live and hands.said_count % 2 == 0,
        }


class SeatView:
    """Projects world points into one seat's half as fractions (0..1) of that half.
    `world_to_screen` answers in screen pixels; the seat camera's own forward point is the
    centre of its viewport, which gives the screen size."""

    def __init__(self, camera: Camera):
        self.camera = camera
        self.viewport = camera.viewport
        eye = camera.entity.transform
        center = camera.world_to_screen(eye.position + eye.forward * 10)
        x, y, w, h = self.viewport
        self.ok = center is not None
        self.width = center.x / (x + w / 2) if self.ok else 1
        self.height = center.y / (y + h / 2) if self.ok else 1

    def place(self, point: Vec3):
        if not self.ok:
            return None
        screen = self.camera.world_to_screen(point)
        if screen is None:
            return None
        x, y, w, h = self.viewport
        return ((screen.x / self.width - x) / w, (screen.y / self.height - y) / h)


@ui("chef_guide", html="ui/chef_guide.html", when=in_service)
class ChefGuide(PlayerPanel):
    """Wayfinding in each chef's half: a pin over every station in range, the chef's goal
    filled with its colour (or an arrow at the half's edge pointing at it), and the
    carrying pill over the chef."""

    def state(self, ctx, player):
        chef = player.entity
        hands = chef.get(Chef)
        rules = ctx.config(ServiceRules)
        view = SeatView(ctx.camera.for_player(player))
        here = chef.transform.position
        pins = []
        goal_on = False
        for station, kind in ctx.world.query(Station).near(here, rules.guide_range).by_distance(here):
            spot = view.place(station.transform.position + vec3(0, PIN_LIFT, 0))
            is_goal = station == hands.goal
            on = spot is not None and PIN_BAND[0] <= spot[1] <= PIN_BAND[1] and 0 <= spot[0] <= 1
            goal_on = goal_on or (is_goal and on)
            if not on:
                continue
            pot = station.try_get(Pot)
            state = pot.state if pot is not None else PotState.EMPTY
            near = is_goal or wanted(station, hands.held, rules)
            pins.append({
                "x": pct(spot[0]), "y": pct(spot[1]),
                "label": ctx.text(kind.kind.data.label),
                "distance": f"{round(here.distance_to(station.transform.position))}m" if near else "",
                "color": css(kind.kind.data.color),
                "goal": is_goal,
                "cooking": state is PotState.COOKING,
                "ready": state is PotState.READY,
                "burnt": state is PotState.BURNT,
            })
        return {"pins": pins, **self.edge(ctx, hands.goal, here, goal_on), **self.chip(ctx, chef, view)}

    def edge(self, ctx: Context, goal: Entity | None, here: Vec3, goal_on: bool) -> dict:
        """Off the half: an arrow along the bearing to the goal (0 = up, clockwise; the
        chase camera looks along +z, so screen-up is world +z and screen-right is +x)."""
        if goal is None or goal_on:
            return {"edge": False, "edge_col": False, "edge_rev": False, "edge_x": "-99%", "edge_y": "-99%",
                    "edge_color": "transparent", "edge_turn": "none", "edge_label": ""}
        to = goal.transform.position - here
        deg = math.degrees(math.atan2(to.x, to.z))
        dx, dy = math.sin(math.radians(deg)), -math.cos(math.radians(deg))
        horizontal = abs(dx) > abs(dy) * 0.6
        half_w, half_h = 0.37, (EDGE_BAND[1] - EDGE_BAND[0]) / 2 - 0.03
        reach = min(half_w / abs(dx) if abs(dx) > 1e-4 else 1e9, half_h / abs(dy) if abs(dy) > 1e-4 else 1e9)
        kind = goal.get(Station).kind.data
        return {
            "edge": True,
            "edge_col": not horizontal,
            "edge_rev": (dx > 0) if horizontal else (dy > 0),
            "edge_x": pct(0.5 + dx * reach),
            "edge_y": pct((EDGE_BAND[0] + EDGE_BAND[1]) / 2 + dy * reach),
            "edge_color": css(kind.color),
            "edge_turn": f"rotate({deg:.0f}deg)",
            "edge_label": f"{ctx.text(kind.label)} {round(to.length())}m",
        }

    def chip(self, ctx: Context, chef: Entity, view: SeatView) -> dict:
        held = chef.get(Chef).held
        spot = view.place(chef.transform.position + vec3(0, CHIP_LIFT, 0)) if held is not None else None
        return {
            "carrying": spot is not None,
            "held_x": pct(spot[0]) if spot is not None else "-99%",
            "held_y": pct(spot[1]) if spot is not None else "-99%",
            "held": held.id.replace("_", " ") if held is not None else "",
            "held_color": held_color(held.data if held is not None else None, held.id if held is not None else ""),
        }


@ui("title_screen", html="ui/title.html", modal=True, layer="menu",
    when=lambda ctx: not ctx.get(Service).opened)
class TitleScreen(Panel):
    """A modal over the first kitchen: Open Kitchen starts the service."""

    actions = {"start": open_kitchen}

    def state(self, ctx):
        names = [short_name(ctx.text(k.data.name)) for k in ctx.config(ServiceRules).kitchens]
        return {
            "kitchens_count": ctx.text(Text.kitchens_count, count=len(names)),
            "stops": [{"name": name, "more": index < len(names) - 1} for index, name in enumerate(names)],
            "stops_line": " · ".join(names),
        }


@ui("service_over", html="ui/service_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Service).result is not Result.COOKING)
class ServiceOver(Panel):
    """The service receipt: won or out of time, the kitchens cleared, the score with the
    New Best stamp, and the night's numbers."""

    actions = {"play_again": play_again, "main_menu": main_menu}

    def state(self, ctx):
        service, today, rules = ctx.get(Service), kitchen(ctx), ctx.config(ServiceRules)
        won = service.result is Result.WON
        total = sum(service.scores)
        return {
            "title": ctx.text(Text.service_complete if won else Text.out_of_time),
            "lost": not won,
            "result": (ctx.text(Text.all_kitchens, count=len(rules.kitchens)) if won
                       else ctx.text(Text.needed, target=today.target, kitchen=ctx.text(today.name))),
            "kitchens": [kitchen_pill(ctx, entry.data, index, service, won) for index, entry in enumerate(rules.kitchens)],
            "score": total,
            "new_best": total > 0 and total > service.best_at_start,
            "served": service.served,
            "best_streak": f"x{service.best_streak}",
            "missed": service.missed,
            "burnt": service.burnt,
            "binned": service.binned,
            "prep": service.prep_actions,
            "best_ever": ctx.get(Record).best_score,
        }


def kitchen_pill(ctx: Context, today, index: int, service: Service, won: bool) -> dict:
    done = index < service.kitchen or (index == service.kitchen and won)
    failed = index == service.kitchen and not won
    name = short_name(ctx.text(today.name))
    return {"name": ("✓ " if done else "✕ " if failed else "") + name, "done": done, "failed": failed}
