import math

from parallax import ContentRef, Panel, Player, PlayerPanel, load_scene, ui
from parallax.combat import Side
from project import Scenes, Text

from features.economy.feature import Wallet, stat_lines

from features.heroes.feature import Hero
from features.match.resources import Record
from features.match.rpcs import lock_in, pick_champion
from game.components import Blue
from game.content import ChampionDef, FactionDef
from game.resources import Match, Phase
from game.svg import svg_image
from game.viewer import my_hero


def _hash(text: str) -> int:
    h = 0
    for ch in text:
        h = (h * 31 + ord(ch)) % 100003
    return h


def _rgba(color, alpha: float) -> str:
    return f"rgba({round(color.r * 255)},{round(color.g * 255)},{round(color.b * 255)},{alpha})"


def crest(ref: ContentRef[ChampionDef]) -> dict:
    """The template's generated portrait: the champion's colour as a lit ground, a
    sigil of chords hashed from its id (the same champion always draws the same
    crest) and its class glyph."""
    champion = ref.data
    seed = _hash(ref.id)
    points = []
    for i in range(5):
        a = math.radians((seed * (i + 3)) % 360)
        r = 26 + ((seed >> (i + 1)) % 22)
        points.append(f"{50 + math.cos(a) * r:.1f},{50 + math.sin(a) * r:.1f}")
    look = {
        "ground": (f"radial-gradient(72% 72% at 50% 34%, {_rgba(champion.color, 0.95)} 0%, "
                   f"{_rgba(champion.color, 0.34)} 58%, rgba(8,10,16,0.98) 100%)"),
        "sigil_img": svg_image("0 0 100 100", (
            f"<polygon points='{' '.join(points)}' fill='rgba(255,255,255,0.07)' stroke='rgba(255,255,255,0.30)' stroke-width='1.1'/>"
            f"<path d='M50 6 L92 30 L92 70 L50 94 L8 70 L8 30 Z' fill='none' stroke='{_rgba(champion.color, 0.22)}' stroke-width='2'/>"
            "<rect width='100' height='100' fill='none' stroke='rgba(0,0,0,0.55)' stroke-width='6'/>")),
    }
    for icon in ROLE_ICONS:
        look[f"icon_{icon}"] = champion.role_icon == icon
    return look


ROLE_ICONS = ("swords", "spark", "bow", "venom", "aegis")


@ui("draft_board", html="ui/draft.html", modal=True,
    when=lambda ctx: ctx.get(Match).phase is Phase.DRAFT and my_hero(ctx) is not None)
class DraftBoard(Panel):
    """Champion select: both teams' slots, the champion you hold on the stage, every
    champion's card and your pick's kit, and the clock. Open exactly while the
    server's match is drafting; clicks call the server."""

    actions = {"pick": pick_champion, "lock": lock_in}

    def state(self, ctx):
        mine = my_hero(ctx)
        hero = mine.get(Hero)
        selected = hero.champion
        left = max(0, round(ctx.get(Match).draft_ends_at - ctx.time.now))
        slots = {"blue": [], "red": []}
        picks = {}
        for e, h in ctx.world.query(Hero):
            side = "blue" if e.get(Side).side == Blue else "red"
            owner = e.owner
            slots[side].append({
                "name": owner.name if owner else ctx.text(Text.draft_bot),
                "champion": ctx.text(h.champion.data.name),
                "locked": h.locked,
                "you": e == mine,
                **crest(h.champion),
            })
            if e != mine:
                picks.setdefault(h.champion, not ctx.combat.are_enemies(mine, e))
        blue = ctx.content(FactionDef).first(lambda f: f.side == Blue)
        red = ctx.content(FactionDef).first(lambda f: f.side != Blue)
        champion = selected.data
        return {
            "seconds_left": left,
            "urgent": left <= 5,
            "locked": hero.locked,
            "blue_name": ctx.text(blue.data.name),
            "red_name": ctx.text(red.data.name),
            "blue_slots": slots["blue"],
            "red_slots": slots["red"],
            "champions": [self._card(ctx, c, picked=c == selected, ally=picks.get(c)) for c in ctx.content(ChampionDef)],
            "stage": {
                "name": ctx.text(champion.name),
                "role": ctx.text(champion.role),
                "passive": ctx.text(champion.passive_name),
                "passive_text": " · ".join(line["text"] for line in stat_lines(ctx, champion.passive)),
                **crest(selected),
            },
            "stage_glow": (f"radial-gradient(60% 62% at 50% 74%, {_rgba(champion.color, 0.42)}, "
                           f"{_rgba(champion.color, 0.10)} 46%, rgba(0,0,0,0) 76%)"),
            "stage_floor": f"radial-gradient(50% 50% at 50% 50%, {_rgba(champion.color, 0.55)}, rgba(0,0,0,0) 72%)",
            "kit": [{"key": key, "name": ctx.text(a.data.name), "blurb": ctx.text(a.data.blurb)}
                    for key, a in zip("QWER", champion.abilities)],
        }

    def _card(self, ctx, ref: ContentRef[ChampionDef], *, picked: bool, ally: bool | None) -> dict:
        champion = ref.data
        taken = "" if ally is None else ctx.text(Text.draft_ally_pick if ally else Text.draft_enemy_pick)
        return {
            "champion": ref.id,
            "picked": picked,
            "name": ctx.text(champion.name),
            "role": ctx.text(champion.role),
            "taken": taken,
            **crest(ref),
        }


@ui("game_over", html="ui/game_over.html", modal=True,
    when=lambda ctx: ctx.get(Match).phase is Phase.ENDED)
class GameOverScreen(PlayerPanel):
    """Victory or defeat as this seat sees it, the winning faction, the match card and
    this player's record."""

    actions = {"play_again": load_scene(Scenes.arena), "main_menu": load_scene(Scenes.title)}

    def state(self, ctx, player: Player):
        match = ctx.get(Match)
        mine = player.entity
        record = ctx.get(Record, player=player)
        won = mine.get(Side).side == match.winner
        winner = ctx.content(FactionDef).first(lambda f: f.side == match.winner)
        seconds = max(0, int(match.ended_at - match.started_at))
        hero = mine.get(Hero)
        return {
            "won": won,
            "lost": not won,
            "red_won": match.winner != Blue,
            "winner_line": ctx.text(Text.go_wins, faction=ctx.text(winner.data.name)) if winner else "",
            "match_time": f"{seconds // 60}:{seconds % 60:02d}",
            "team_kills": f"{match.blue_kills} – {match.red_kills}",
            "objectives": f"{match.blue_towers} / {match.red_towers}",
            "gold": f"{mine.get(Wallet).gold:,}",
            "takedowns": f"{hero.kills} / {hero.deaths}",
            "record": f"{record.wins}W – {record.losses}L",
        }
