"""Panels. They run on each captain's client and read only replicated state: the
voyage resource, and the components of that captain's own ship (the HUD is a
`PlayerPanel`, handed its captain). The refit draft and the game-over screen follow the
voyage's phase; their buttons call the server."""

import math

from parallax import Panel, PlayerPanel, System, close_panel, on, open_panel, system, ui
from parallax.net import MatchStarting
from parallax.combat import Health
from parallax.vehicles import Vehicle
from project import Text

from game.actions import Helm
from game.components import Broadsides, CursedHoard, Ghost, Kraken, Rig, Shark, TreasureChest
from game.content import ContractKind, FactionDef, Stat
from game.config import VoyageRules
from game.net import pick_refit, sail_again, take_contract
from game.resources import Harbour, Ledger, Phase, Voyage
from game.rules import crew_left, current_leg, squall_raging
from game.standing import perk_text, rank, standing


def leg_of(ctx):
    return ctx.text(Text.leg_of, number=ctx.get(Voyage).leg + 1, total=len(ctx.config(VoyageRules).legs))


def scoreboard(ctx):
    plunder = ctx.get(Voyage).plunder
    rows = [{"name": player.name, "gold": plunder.get(player.id, 0), "me": player.local} for player in ctx.players]
    return sorted(rows, key=lambda row: -row["gold"])


def contract_status(ctx):
    """The contract board line: the open contract and its progress, or the prompt."""
    voyage = ctx.get(Voyage)
    if voyage.contract is None:
        return {"has_contract": False, "contract": ctx.text(Text.contract_prompt)}
    terms = voyage.contract.data
    return {
        "has_contract": True,
        "contract": f"{ctx.text(terms.label)}: {voyage.contract_progress}/{terms.goal} · {terms.gold} gold",
    }


def standing_rows(ctx):
    return [
        {
            "name": ctx.text(faction.data.name),
            "rank": ctx.text(rank(ctx, faction).name),
            "value": round(standing(ctx, faction)),
            "perk": perk_text(ctx, faction),
            "hostile": rank(ctx, faction).hostile,
            "width": f"{(standing(ctx, faction) - faction.data.min) / (faction.data.max - faction.data.min) * 100:.0f}%",
        }
        for faction in ctx.content(FactionDef)
    ]


def spyglass_targets(ctx):
    """What the spyglass points at: the open contract's quarry, else the treasure field."""
    voyage = ctx.get(Voyage)
    kind = voyage.contract.data.kind if voyage.contract is not None else None
    if kind is ContractKind.TREASURE:
        return Text.spyglass_treasure, ctx.world.query(tagged=CursedHoard).entities()
    if kind is ContractKind.GHOST:
        return Text.spyglass_ghost, ctx.world.query(tagged=Ghost).entities()
    if kind is ContractKind.MONSTER:
        return Text.spyglass_monster, (ctx.world.query(tagged=Kraken).entities()
                                       + ctx.world.query(tagged=Shark).entities())
    return Text.spyglass_treasure, ctx.world.query(tagged=TreasureChest).entities()


def spyglass(ctx, ship):
    """The spyglass compass: bearing to the nearest target, relative to the bow (degrees,
    + to starboard), and its distance."""
    label, targets = spyglass_targets(ctx)
    at = ship.transform.position
    nearest = min(targets, key=lambda target: (target.transform.position - at).length(), default=None)
    if nearest is None:
        return {"spyglass": True, "spy_label": ctx.text(label), "spy_distance": "—", "spy_needle": "rotate(0deg)"}
    gap = nearest.transform.position - at
    bow = ship.transform.forward
    bearing = math.degrees(math.atan2(gap.x, gap.z) - math.atan2(bow.x, bow.z))
    bearing = (bearing + 180) % 360 - 180
    return {
        "spyglass": True,
        "spy_label": ctx.text(label),
        "spy_bearing": round(bearing),
        "spy_distance": f"{round(math.hypot(gap.x, gap.z))} m",
        "spy_needle": f"rotate({round(bearing)}deg)",
    }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", toggle_with=Helm.pause)
class PauseMenu(Panel):
    """A menu only: in a shared sea nobody can stop the clock."""
    actions = {"resume": close_panel()}

    def state(self, ctx):
        voyage = ctx.get(Voyage)
        leg = current_leg(ctx)
        return {
            "voyage_details": f"{ctx.text(leg.name)} · {voyage.purse} gold · {max(0, crew_left(ctx))} crew",
            "sailing_details": ctx.text(Text.gold_of, gold=voyage.leg_gold, quota=leg.gold_quota),
        }


@ui("hud", html="ui/hud.html", when=lambda ctx: not ctx.get(Harbour).at_title)
class Hud(PlayerPanel):
    """Each captain's own HUD: the shared voyage, plus their own ship while it floats."""
    actions = {"pause": open_panel(PauseMenu), "take_contract": take_contract}

    def state(self, ctx, player):
        voyage = ctx.get(Voyage)
        leg = current_leg(ctx)
        minutes, seconds = divmod(int(voyage.time_left), 60)
        ship = player.entity
        status = contract_status(ctx)
        terms = voyage.contract.data if voyage.contract is not None else None
        bounty_done = voyage.bounty >= leg.bounty_count
        return {
            "leg": leg_of(ctx),
            "leg_name": ctx.text(leg.name),
            "clock": f"{minutes}:{seconds:02d}",
            "clock_low": voyage.time_left <= 30,
            "gold": voyage.leg_gold,
            "quota": leg.gold_quota,
            "gold_width": f"{min(1.0, voyage.leg_gold / leg.gold_quota) * 100:.1f}%",
            "gold_full": voyage.leg_gold >= leg.gold_quota,
            "bounty_label": ctx.text(leg.bounty_label),
            "bounty_count": f"{min(voyage.bounty, leg.bounty_count)} / {leg.bounty_count}",
            "bounty_done": bounty_done,
            "bounty_mark": "✓" if bounty_done else "",
            "crew": max(0, crew_left(ctx)),
            "purse": voyage.purse,
            "storm": squall_raging(ctx),
            "scoreboard": scoreboard(ctx),
            "sunk": ship is None,
            "has_contract": status["has_contract"],
            "no_contract": not status["has_contract"],
            "contract": ctx.text(terms.label) if terms else "",
            "contract_count": f"{voyage.contract_progress} / {terms.goal}" if terms else "",
            "standing": standing_rows(ctx),
            **(self.ship_status(ship) if ship is not None else {}),
            **(spyglass(ctx, ship) if ship is not None else {"spyglass": False}),
        }

    def ship_status(self, ship):
        rig = ship.get(Rig)
        guns = ship.get(Broadsides)
        hull = ship.get(Health).fraction
        return {
            "hull_width": f"{hull * 100:.0f}%",
            "hull_pct": f"{round(hull * 100)}%",
            "hull_low": hull <= 0.3,
            "sail_pct": f"{round(rig.sail * 100)}%",
            "anchored": rig.anchored,
            "knots": f"{abs(ship.get(Vehicle).speed) * 1.944:.1f}",
            "port": [{"empty": i >= guns.port} for i in range(guns.rack)],
            "starboard": [{"empty": i >= guns.starboard} for i in range(guns.rack)],
            "port_reload": f"{guns.port_reload * 100:.0f}%",
            "starboard_reload": f"{guns.starboard_reload * 100:.0f}%",
        }


REFIT_ICONS = {
    Stat.MAX_HULL: "🛡️", Stat.ARMOR: "🛡️", Stat.HULL_REGEN: "🔧", Stat.CANNON_DAMAGE: "💥",
    Stat.CANNON_RANGE: "🎯", Stat.BROADSIDE: "💥", Stat.RELOAD_CUT: "🔥", Stat.MAX_SPEED: "⛵",
    Stat.PICKUP_RADIUS: "🪝", Stat.TREASURE_BONUS: "💰", Stat.BOUNTY_BONUS: "📜", Stat.CREW: "⚓",
}
"""The refit card's badge by the stat it tunes (the template's `_REFIT_ICONS`)."""


def set_sail(ctx) -> None:
    """The title's Set Sail: this captain leaves the title card for the refit in port."""
    ctx.get(Harbour).at_title = False


def sail_with_crew(ctx) -> None:
    """The title's Sail With a Crew: host a co-op room on the platform's lobby. Crewmates
    join it by code or invite; the host's Weigh Anchor starts the voyage for everyone
    (`board_crew`). Without a lobby service (a local run) it says so."""
    lobby = ctx.net.lobby
    if not lobby.available:
        ctx.ui.toast(ctx.text(Text.crew_no_lobby), seconds=3)
    elif not lobby.in_room:
        lobby.host(name=ctx.text(Text.crew_room_name), mode="coop")


def start_crew(ctx) -> None:
    if ctx.net.lobby.is_host:
        ctx.net.lobby.start()


def leave_crew(ctx) -> None:
    ctx.net.lobby.leave()


@system("board_crew", runs_on="everywhere")
class BoardCrew(System):
    """When the room's match starts, every member leaves the title card for the refit."""

    @on(MatchStarting)
    def starting(self, ctx, event: MatchStarting):
        ctx.get(Harbour).at_title = False


@ui("title_screen", html="ui/title.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Harbour).at_title)
class TitleScreen(Panel):
    """The template's title card: the three-sea chart, the career ledger, Set Sail and
    Sail With a Crew."""
    actions = {"set_sail": set_sail, "sail_with_crew": sail_with_crew, "start_crew": start_crew,
               "leave_crew": leave_crew}

    def state(self, ctx):
        lobby = ctx.net.lobby
        room = lobby.room if lobby.available and lobby.in_room else None
        crew = {
            "in_room": room is not None,
            "can_start": room is not None and lobby.is_host,
            "waiting": room is not None and not lobby.is_host,
            "room_line": ctx.text(Text.crew_room_line, code=room.code, players=room.players,
                                  max=room.max_players) if room else "",
        }
        ledger = ctx.get(Ledger)
        legs = ctx.config(VoyageRules).legs
        best = legs[min(ledger.best_leg, len(legs)) - 1].data if ledger.best_leg else None
        return {
            **crew,
            "career_gold": f"{ledger.gold:,}",
            "voyages_won": ledger.voyages_won,
            "furthest": ctx.text(best.name) if best else "—",
        }


@ui("refit", html="ui/refit.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Voyage).phase is Phase.REFIT and not ctx.get(Harbour).at_title)
class RefitPanel(Panel):
    actions = {"pick": pick_refit}

    def state(self, ctx):
        voyage = ctx.get(Voyage)
        leg = current_leg(ctx)
        return {
            "sub": ctx.text(Text.refit_sub, name=ctx.text(leg.name), brief=ctx.text(leg.brief),
                            quota=leg.gold_quota, crew=max(0, crew_left(ctx))),
            "cards": [
                {
                    "upgrade": card.id,
                    "icon": REFIT_ICONS.get(card.data.stat, "⚙️"),
                    "name": ctx.text(card.data.name),
                    "blurb": ctx.text(card.data.blurb),
                }
                for card in voyage.offers
            ],
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Voyage).phase is Phase.ENDED)
class GameOverPanel(Panel):
    actions = {"sail_again": sail_again}

    def state(self, ctx):
        voyage = ctx.get(Voyage)
        stat = lambda label, value: {"label": ctx.text(label), "value": str(value)}
        stats = [stat(Text.legs_cleared, f"{voyage.leg + int(voyage.won)}/{len(ctx.config(VoyageRules).legs)}")]
        if not voyage.won:
            stats.append(stat(Text.lost_at, ctx.text(current_leg(ctx).name)))
        stats += [
            stat(Text.crew_left, max(0, crew_left(ctx))),
            stat(Text.refits, sum(voyage.levels.values())),
            stat(Text.contracts, voyage.contracts_paid),
        ]
        stats += [{"label": row["name"], "value": row["rank"]} for row in standing_rows(ctx)]
        return {
            "title": ctx.text(Text.voyage_won if voyage.won else Text.voyage_lost),
            "won": voyage.won,
            "purse": voyage.purse,
            "stats": stats,
        }
