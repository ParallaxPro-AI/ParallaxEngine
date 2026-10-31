"""The title screen, the in-match HUD and the in-match menu. The draft, shop, chat
and game-over panels live with their features."""

import math

from parallax import Color, Context, Entity, Panel, System, close_panel, load_scene, open_panel, system, ui
from parallax.combat import Health, Side
from parallax.hud import MinimapPanel
from project import Scenes, Text

from features.abilities.feature import rank_up
from features.economy.feature import ShopPanel, Wallet
from features.fighting.feature import Stats
from features.heroes.feature import AbilityBook, Hero, Mana, Progression, rank_cap, recall, xp_to_next
from features.vision.feature import WardKit
from game.actions import Controls
from game.components import Blue
from game.config import MatchRules
from game.content import FactionDef
from game.resources import Match, Phase, Session
from game.svg import path_image, svg_image
from game.viewer import my_hero

ICONS = ("M6 24 L16 8 L26 24 L21 24 L16 16 L11 24 Z", "M8 6 H24 V16 C24 22 20 26 16 28 C12 26 8 22 8 16 Z",
         "M16 4 L28 26 L4 26 Z", "M3 13 H17 V6 L29 16 L17 26 V19 H3 Z")
"""The ability tiles' glyphs, Q W E R (the template's ability bar)."""

BANNER_SECONDS = 2.6
"""How long the announcer's line stays up (the template's 220 ms in + 2.2 s hold)."""

BANNER_COLORS = {"gold": "#f2c14e", "success": "#338cf2", "info": "#eef3fa", "warn": "#f2c14e", "danger": "#f24d4d"}
INK = {"blue": "var(--ls-blue-hi)", "red": "var(--ls-red-hi)"}
SWATCH = {"blue": "var(--ls-blue)", "red": "var(--ls-red)"}


def css(color: Color, alpha: float = 1) -> str:
    return f"rgba({round(color.r * 255)}, {round(color.g * 255)}, {round(color.b * 255)}, {alpha})"


def clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def match_time(ctx: Context) -> float:
    match = ctx.get(Match)
    if match.phase is Phase.PLAYING:
        return ctx.time.now - match.started_at
    if match.phase is Phase.ENDED:
        return match.ended_at - match.started_at
    return 0


def faction_names(ctx: Context) -> tuple[str, str]:
    blue = ctx.content(FactionDef).first(lambda f: f.side == Blue)
    red = ctx.content(FactionDef).first(lambda f: f.side != Blue)
    return ctx.text(blue.data.name), ctx.text(red.data.name)


def side_key(side) -> str:
    return "blue" if side == Blue else "red"


def pct(value: float, of: float) -> str:
    return f"{max(0.0, min(100.0, 100 * value / max(of, 1e-6))):.1f}%"


def enter_arena(ctx, *, training: bool) -> None:
    """Leave the title for the arena; Training with Bots marks the session offline, so the
    in-match menu pauses it (the template's offline training)."""
    ctx.get(Session).training = training
    ctx.scenes.load(Scenes.arena)


def play_online(ctx) -> None:
    enter_arena(ctx, training=False)


def play_training(ctx) -> None:
    enter_arena(ctx, training=True)


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    """The wordmark, the factions and the template's three modes. The match is hosted by
    this player's game (`net(mode="host")`): Find Match goes through the platform's
    matchmaking; Custom Match and Training with Bots start it here, bots filling both
    teams, so the draft, the match and the HUD run solo and offline."""

    actions = {"find_match": play_online, "custom_match": play_online, "training": play_training}

    def state(self, ctx):
        blue, red = faction_names(ctx)
        return {"blue_name": blue, "red_name": red}


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.arena], toggle_with=Controls.menu)
class PauseMenu(Panel):
    """P: online the match keeps running, so this is a menu, not a pause; in Training with
    Bots it pauses (`TrainingPause`), and says so."""

    actions = {"resume": close_panel(), "main_menu": load_scene(Scenes.title)}

    def state(self, ctx):
        return {"clock": clock(match_time(ctx)), "training": ctx.get(Session).training}


@system("training_pause", scenes=[Scenes.arena], runs_on="everywhere", runs_while_frozen=True)
class TrainingPause(System):
    """Training is offline, so its menu stops the clock, the bots and the waves: game time
    stands still while the menu is open (a networked game's modal never freezes it)."""

    def update(self, ctx, dt):
        paused = ctx.get(Session).training and ctx.ui.is_open(PauseMenu)
        scale = 0.0 if paused else 1.0
        if ctx.time.scale != scale:
            ctx.time.scale = scale


@ui("hud", html="ui/hud.html", scenes=[Scenes.arena], when=lambda ctx: my_hero(ctx) is not None)
class Hud(Panel):
    """The score strip, kill feed and announcer, your champion's dock (portrait, vitals,
    abilities, wards) and the shop / recall / controls chips."""

    actions = {"rank_up": rank_up, "shop": open_panel(ShopPanel), "recall": recall}

    def state(self, ctx):
        me = my_hero(ctx)
        hero = me.get(Hero)
        health = me.get(Health)
        stats = me.get(Stats)
        progression = me.get(Progression)
        match = ctx.get(Match)
        mine = side_key(me.get(Side).side)
        blue, red = faction_names(ctx)
        champion = hero.champion.data
        mana = me.get(Mana).current
        xp_next = xp_to_next(ctx, progression.level)
        recall_left = max(0.0, hero.recall_at - ctx.time.now) if hero.recall_at else 0
        return {
            "blue_name": blue, "red_name": red,
            "blue_kills": match.blue_kills, "red_kills": match.red_kills,
            "blue_towers": match.blue_towers, "red_towers": match.red_towers,
            "clock": clock(match_time(ctx)),
            "gold_text": f"{me.get(Wallet).gold:,}",
            "level": progression.level,
            **self._objective(ctx, match, mine),
            "feed": [self._feed_row(ctx, line, mine) for line in reversed(match.feed)],
            **self._banner(ctx, match, me),
            "dead": health.dead,
            "low": not health.dead and health.fraction < 0.2,
            "respawn_in": math.ceil(hero.respawn_at - ctx.time.now) if health.dead else 0,
            "crest_glow": css(champion.color, 0.45),
            "crest_img": svg_image("0 0 40 46", f"<path d='M4 4 H36 V22 C36 33 28 40 20 44 C12 40 4 33 4 22 Z' fill='{css(champion.color)}'/>"
                                                f"<path d='{champion.crest}' fill='rgba(255,255,255,.94)'/>"),
            "hp_pct": pct(health.current, health.max),
            "shield_pct": pct(min(health.shield, health.max - health.current), health.max),
            "hp_text": f"{round(health.current):,} / {round(health.max):,}",
            "mp_pct": pct(mana, stats.max_mana),
            "mp_text": f"{round(mana):,} / {round(stats.max_mana):,}",
            "xp_pct": pct(progression.xp, xp_next),
            "abilities": self._ability_bar(ctx, me, mana),
            "recalling": recall_left > 0,
            "recall_left": f"{recall_left:.1f}",
            "recall_pct": pct(ctx.config(MatchRules).recall_seconds - recall_left, ctx.config(MatchRules).recall_seconds),
            **self._wards(ctx, me),
        }

    def _objective(self, ctx, match: Match, mine: str) -> dict:
        own_exposed = match.blue_core_exposed if mine == "blue" else match.red_core_exposed
        enemy_exposed = match.red_core_exposed if mine == "blue" else match.blue_core_exposed
        if enemy_exposed:
            return {"objective": ctx.text(Text.objective_enemy_exposed), "objective_warn": False}
        if own_exposed:
            return {"objective": ctx.text(Text.objective_own_exposed), "objective_warn": True}
        return {"objective": ctx.text(Text.objective_enemy_shielded), "objective_warn": False}

    def _feed_row(self, ctx, line, mine: str) -> dict:
        killer = side_key(line.killer_side) if line.killer_side else ""
        victim = side_key(line.victim_side) if line.victim_side else ""
        return {
            "killer": line.killer, "victim": line.victim, "time": clock(line.at),
            "mine": killer == mine,
            "swatch": SWATCH.get(killer, "var(--ls-jungle-gold)"),
            "killer_ink": INK.get(killer, "var(--ls-ink)"),
            "victim_ink": INK.get(victim, "var(--ls-jungle)"),
        }

    def _banner(self, ctx, match: Match, me: Entity) -> dict:
        banner = match.banner
        style = banner.style
        if style == "kill":
            style = "gold" if banner.side == me.get(Side).side else "danger"
        return {
            "banner_on": bool(banner.text) and ctx.time.now - banner.at < BANNER_SECONDS,
            "banner_text": banner.text,
            "banner_small": banner.small,
            "banner_color": BANNER_COLORS.get(style, BANNER_COLORS["info"]),
        }

    def _ability_bar(self, ctx, me: Entity, mana: float) -> list[dict]:
        book = me.get(AbilityBook)
        level = me.get(Progression).level
        points = me.get(Progression).skill_points
        dead = me.get(Health).dead
        slots = []
        for slot, (key, ref) in enumerate(zip("QWER", book.abilities)):
            ability, rank = ref.data, book.ranks[slot]
            unlearned = rank == 0
            full = ability.cooldown.at(max(rank, 1))
            left = max(0.0, book.ready_at[slot] - ctx.time.now)
            cooling = not unlearned and left > 0
            cost = round(ability.mana.at(max(rank, 1)))
            can = points > 0 and rank < rank_cap(ctx, ability, level) and not dead
            sweep = f"conic-gradient(rgba(4,7,14,.74) 0 {360 * min(1, left / max(full, 0.01)):.0f}deg, transparent 0)" if cooling else "none"
            if unlearned:
                meta = ctx.text(Text.hud_unlocks_at) if ability.ultimate and level < 6 else ctx.text(Text.hud_not_learned)
            else:
                meta = ctx.text(Text.hud_rank, rank=rank, seconds=round(full, 1))
            slots.append({
                "slot": slot,
                "key": key,
                "icon_img": path_image("0 0 32 32", ICONS[slot], "#eef3fa"),
                "name": ctx.text(ability.name),
                "title": f"{ctx.text(ability.name)} — {ctx.text(ability.blurb)}",
                "unlearned": unlearned,
                "locked": unlearned and not can,
                "cooling": cooling,
                "no_mana": not unlearned and not cooling and mana < cost,
                "sweep": sweep,
                "cd": str(math.ceil(left)) if cooling and not dead else "",
                "cost": str(cost) if cost else "",
                "meta": meta,
                "can_rank_up": can,
                "learn": f"{key} +" if unlearned else "+",
            })
        return slots

    def _wards(self, ctx, me: Entity) -> dict:
        rules = ctx.config(MatchRules)
        kit = me.get(WardKit)
        left = max(0.0, kit.charge_at - ctx.time.now) if kit.charges < rules.ward_charges else 0
        empty = kit.charges <= 0
        if kit.charges < rules.ward_charges:
            meta = f"{math.ceil(left)}s"
        else:
            meta = ctx.text(Text.ward_ready)
        hush_left = max(0.0, kit.hush_at - ctx.time.now)
        return {
            "watchfires": kit.watchfires,
            "watchfire_empty": kit.watchfires <= 0,
            "watchfire_meta": f"{kit.watchfires}/{rules.watchfires}",
            "hush_cooling": hush_left > 0,
            "hush_curtain": pct(hush_left, rules.hushbell_cooldown),
            "hush_cd": str(math.ceil(hush_left)) if hush_left > 0 else "",
            "hush_meta": f"{math.ceil(hush_left)}s" if hush_left > 0 else ctx.text(Text.ward_ready),
            "wards": kit.charges,
            "wards_empty": empty,
            "ward_curtain": pct(left, rules.ward_recharge) if empty else "0%",
            "ward_cd": (str(math.ceil(left)) if left >= 10 else f"{left:.1f}") if empty else "",
            "ward_meta": meta,
        }


@ui("tactical_map", html="ui/minimap.html", scenes=[Scenes.arena], when=lambda ctx: my_hero(ctx) is not None)
class TacticalMap(MinimapPanel):
    """The HUD kit's minimap in the template's tactical-map bezel, bottom right (the
    built-in steps aside for this subclass)."""
