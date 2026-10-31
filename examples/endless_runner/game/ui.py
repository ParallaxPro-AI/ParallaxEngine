"""Panels: title, HUD, the Lock-Up, pause and the end card, and the two menu
actions that need logic (starting a run in a mode, quitting one)."""

from parallax import Panel, Settings, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.config import Rules
from game.content import DistrictDef, PowerUpEffect, UpgradeDef
from game.resources import Profile, Run
from game.systems.lockup import buy, keep_records, level_of, next_cost


def play(ctx, endless: bool):
    """Start an escape, or a Night Shift once it's unlocked. The mode is a
    session choice, so "Run again" keeps it."""
    run = Run(endless=endless and ctx.get(Profile).endless_unlocked)
    ctx.scenes.load(Scenes.street, new_run=True, init=[run])


def abandon(ctx):
    """Quit from the pause menu. The run's records are still kept."""
    keep_records(ctx, won=False)
    ctx.scenes.load(Scenes.title, new_run=True)


def end_card_due(ctx) -> bool:
    """The run is over and its beat has passed."""
    run = ctx.get(Run)
    return run.over and ctx.time.now >= run.card_at


GLYPHS = {PowerUpEffect.COIN_MAGNET: "MG", PowerUpEffect.SCORE_MULTIPLIER: "×2", PowerUpEffect.SPRINT: "BST"}
BUFF_COLORS = {PowerUpEffect.COIN_MAGNET: "#bbf7d0", PowerUpEffect.SCORE_MULTIPLIER: "#ffda78", PowerUpEffect.SPRINT: "#ffb26b"}


def css(color) -> str:
    return f"rgb({round(color.r * 255)}, {round(color.g * 255)}, {round(color.b * 255)})"


def goal_distance(ctx) -> int:
    return int(ctx.content(DistrictDef)[-1].data.end_distance)


def set_quality(ctx, value: str):
    """The pause card's graphics switch."""
    ctx.get(Settings).quality = value


@ui("lockup", html="ui/lockup.html", modal=True, layer="menu")
class LockUpPanel(Panel):
    """Kit Up: the wallet, your records and one card per upgrade with its tier pips."""

    actions = {"buy": buy, "close": close_panel(), "play": play}

    def state(self, ctx):
        profile = ctx.get(Profile)
        rows = []
        for upgrade in ctx.content(UpgradeDef):
            cost = next_cost(profile, upgrade)
            level, top = level_of(profile, upgrade), len(upgrade.data.costs)
            affordable = cost is not None and profile.wallet >= cost
            rows.append({
                "upgrade": upgrade.id,
                "icon_path": upgrade.data.icon,
                "name": ctx.text(upgrade.data.name),
                "blurb": ctx.text(upgrade.data.blurb),
                "pips": [{"on": i < level} for i in range(top)],
                "tier": ctx.text(Text.lockup_tier, level=level, max=top),
                "cost": f"{cost or 0:,}",
                "maxed": cost is None,
                "affordable": affordable,
                "unaffordable": cost is not None and not affordable,
                "buy_label": ctx.text(Text.lockup_buy) if affordable or cost is None
                else ctx.text(Text.lockup_need, coins=f"{cost - profile.wallet:,}"),
            })
        return {
            "wallet": f"{profile.wallet:,}",
            "best_distance": f"{profile.best_distance:,}m",
            "goal": f"{goal_distance(ctx):,}m",
            "escapes": profile.escapes,
            "has_escapes": profile.escapes > 0,
            "best_combo": profile.best_combo,
            "upgrades": rows,
        }


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"play": play, "lockup": open_panel(LockUpPanel)}

    def state(self, ctx):
        profile = ctx.get(Profile)
        return {
            "tagline": ctx.text(Text.title_tagline, metres=f"{goal_distance(ctx):,}"),
            "best_distance": f"{profile.best_distance:,}m",
            "escapes": profile.escapes,
            "wallet": f"{profile.wallet:,}",
            "night_shift_unlocked": profile.endless_unlocked,
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.street], toggle_with=Controls.pause)
class PauseMenu(Panel):
    """PAUSED with the live run line, Resume / Main Menu and the Low / Medium / High switch."""

    actions = {"resume": close_panel(), "quit": abandon, "quality": set_quality}

    def state(self, ctx):
        run = ctx.get(Run)
        current = ctx.get(Settings).quality
        return {
            "meta": ctx.text(Text.pause_meta, district=ctx.text(run.district.data.name).upper(),
                             metres=f"{int(run.distance):,}", coins=run.coins),
            "qualities": [
                {"value": q, "label": ctx.text(label), "pressed": "true" if q == current else "false"}
                for q, label in (("low", Text.quality_low), ("medium", Text.quality_medium), ("high", Text.quality_high))
            ],
        }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """The route card (district, distance, points, progress), the coin wallet with the
    combo, the running buffs, the guard bar and the pause button."""

    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        districts = ctx.content(DistrictDef)
        district = run.district.data
        index = next((i for i, d in enumerate(districts) if d == run.district), 0) + 1
        goal = goal_distance(ctx)
        gap, top, catch = run.guard_gap, run.gap_max, rules.guard_catch
        state = "closing" if gap < 3 else "build" if gap < 6 else "keep"
        danger = max(0.0, min(1.0, 1 - (gap - catch) / max(0.1, top - catch)))
        buffs = []
        for kind, until in run.buffs.items():
            left = until - ctx.time.now
            if left <= 0 or kind.data.seconds <= 0:
                continue
            buffs.append({"name": ctx.text(kind.data.name), "left": round(left), "glyph": GLYPHS.get(kind.data.effect, "★"),
                          "color": BUFF_COLORS.get(kind.data.effect, "#8ddbd0"),
                          "fill_pct": f"{min(1.0, left / kind.data.seconds) * 100:.0f}%"})
        return {
            "district": ctx.text(district.name).upper(),
            "district_number": (ctx.text(Text.night_shift_caps) if run.endless
                                else ctx.text(Text.district_of, number=index, total=len(districts))),
            "district_tint": css(district.tint),
            "distance": f"{int(run.distance):,}",
            "score": f"{run.score:,}",
            "goal": "∞" if run.endless else f"{goal:,}",
            "progress_pct": "100%" if run.endless else f"{min(1.0, run.distance / goal) * 100:.1f}%",
            "coins": f"{run.coins:,}",
            "combo": run.combo,
            "shields": run.shields,
            "buffs": buffs,
            "counting": ctx.time.now < run.hold_until,
            "closing": state == "closing",
            "build": state == "build",
            "guard_label": ctx.text({"closing": Text.guard_closing, "build": Text.guard_build, "keep": Text.guard_keep}[state]),
            "guard_color": {"closing": "#ff5a4e", "build": "#ffda78", "keep": "#8ddbd0"}[state],
            "guard_bar": {"closing": "linear-gradient(90deg,#ff9a3c,#ff3b3b)", "build": "linear-gradient(90deg,#ffe59a,#ffb26b)",
                          "keep": "#8ddbd0"}[state],
            "guard_bar_mobile": {"closing": "linear-gradient(90deg,#c2410c,#dc2626)",
                                 "build": "linear-gradient(90deg,#b8862a,#c9702e)", "keep": "#4f9e95"}[state],
            "gap": f"{gap:.1f}",
            "gap_max": round(top, 1),
            "catch": catch,
            "danger_pct": f"{danger * 100:.0f}%",
            "bust_pct": f"{max(4.0, min(40.0, catch / max(0.1, top) * 100 + 2)):.0f}%",
            **goal_card(ctx),
            **coach_card(ctx),
        }


def goal_card(ctx) -> dict:
    """The run-goal card, bottom left: a distance with a combo held, for a coin bonus."""
    rules, run = ctx.config(Rules), ctx.get(Run)
    target, combo_goal, reward = int(rules.mission_distance), rules.mission_combo, rules.mission_reward
    dist, combo = int(min(target, run.distance)), min(combo_goal, run.best_combo)
    done = run.mission_paid
    return {
        "goal_done": done,
        "goal_title": ctx.text(Text.goal_done_title if done else Text.goal_title, coins=reward),
        "goal_title_short": ctx.text(Text.goal_done_short if done else Text.goal_short, coins=reward),
        "goal_line": (ctx.text(Text.goal_done_line) if done else
                      ctx.text(Text.goal_line, metres=dist, target=target, combo=combo, max=combo_goal)),
        "goal_line_short": (ctx.text(Text.goal_done_line_short, coins=reward) if done else
                            ctx.text(Text.goal_line_short, metres=dist, target=target, combo=combo, max=combo_goal)),
        "goal_fill": f"{dist / max(1, target) * 100:.0f}%",
        **{f"goal_pip_{i}": combo >= i for i in (1, 2, 3)},
    }


COACH = {
    1: (["A", "D"], ["l", "r"], Text.coach_lane, Text.coach_lane_touch, Text.coach_lane_line),
    2: (["W", "↑"], ["u"], Text.coach_jump, Text.coach_jump_touch, Text.coach_jump_line),
    3: (["S", "↓"], ["dn"], Text.coach_slide, Text.coach_slide_touch, Text.coach_slide_line),
}


def coach_card(ctx) -> dict:
    """The first-run coach, bottom centre: lane, then jump, then slide, until each is done once."""
    run = ctx.get(Run)
    step = 0
    if not ctx.get(Profile).tutorial_done:
        step = 1 if not run.learned_lane else 2 if not run.learned_jump else 3 if not run.learned_slide else 0
    if not step:
        return {"coach_on": False, "coach_keys": [], "coach_arrows": [], "coach_title": "", "coach_title_touch": "",
                "coach_line": "", "coach_step": 0}
    keys, arrows, title, touch, line = COACH[step]
    return {
        "coach_on": True,
        "coach_keys": [{"key": k} for k in keys],
        "coach_arrows": [{d: d == a for d in ("l", "r", "u", "dn")} for a in arrows],
        "coach_title": ctx.text(title), "coach_title_touch": ctx.text(touch), "coach_line": ctx.text(line),
        "coach_step": step,
    }


@ui("run_over", html="ui/run_over.html", modal=True, layer="menu", when=end_card_due)
class RunOver(Panel):
    """BUSTED! over the street, or the CLEAN GETAWAY sunset: the score, the run against the
    goal and your best, the stats and Main Menu / Play Again."""

    actions = {
        "retry": reload_scene(new_run=True),
        "quit": load_scene(Scenes.title, new_run=True),
    }

    def state(self, ctx):
        run = ctx.get(Run)
        profile = ctx.get(Profile)
        district = run.district.data
        dist, prev, goal = int(run.distance), run.prev_best_distance, goal_distance(ctx)
        span = max(dist, prev, 1) if run.endless else max(goal, 1)
        name = ctx.text(district.name)
        if run.won:
            kick = ctx.text(Text.kick_new_best if dist > prev else Text.kick_final)
        else:
            kick = ctx.text(Text.kick_night if run.endless else Text.kick_busted, district=name)
        if prev > dist:
            right = ctx.text(Text.short_of_best, metres=f"{prev - dist:,}")
        elif prev > 0 and dist > prev:
            right = ctx.text(Text.new_best_by, metres=f"{dist - prev:,}")
        elif prev > 0:
            right = ctx.text(Text.matched_best)
        else:
            right = ctx.text(Text.first_run)
        gold, mint = "var(--cg-gold-hi)", "var(--cg-mint)"
        if run.won:
            stats = [(Text.stat_distance, f"{dist:,}m", "", ""), (Text.stat_coins, str(run.coins), gold, ""),
                     (Text.stat_best_combo, f"{run.best_combo}x", "", ""), (Text.stat_style, str(run.style), "", ""),
                     (Text.stat_escapes, str(profile.escapes), "var(--cg-gold)", ""),
                     (Text.stat_wallet, f"{profile.wallet:,}", gold, "wallet")]
        else:
            stats = [(Text.stat_distance, f"{dist:,}m", "", ""), (Text.stat_district, name, css(district.tint), ""),
                     (Text.stat_coins, str(run.coins), gold, ""), (Text.stat_best_combo, f"{run.best_combo}x", "", ""),
                     (Text.stat_style, str(run.style), "", ""), (Text.stat_best, f"{max(prev, dist):,}m", mint, ""),
                     (Text.stat_wallet, f"{profile.wallet:,}", gold, "wallet")]
        reach = sum(1 for u in ctx.content(UpgradeDef) if (next_cost(profile, u) or 10 ** 9) <= profile.wallet)
        return {
            "won": run.won,
            "kick": kick,
            "score": f"{run.score:,}",
            "progress_left": (ctx.text(Text.on_night_shift, metres=f"{dist:,}") if run.endless
                              else ctx.text(Text.of_goal, metres=f"{dist:,}", goal=f"{goal:,}")),
            "progress_right": right,
            "progress_pct": f"{min(1.0, dist / span) * 100:.1f}%",
            "has_best": prev > 0,
            "best_pct": f"{min(1.0, prev / span) * 100:.1f}%",
            "night_title": ctx.text(Text.night_unlocked_title if run.won and profile.escapes == 1 else Text.night_open_title),
            "night_line": ctx.text(Text.night_unlocked_line if run.won and profile.escapes == 1 else Text.night_open_line),
            "stat_count": str(len(stats)),
            "stat_mobile": "3" if run.won else "4",
            "stats": [
                {"label": ctx.text(label), "short": ctx.text(Text.stat_combo_short) if label == Text.stat_best_combo
                 else ctx.text(Text.stat_wallet_kept) if kind == "wallet" and not run.won else ctx.text(label),
                 "value": value, "color": color, "wallet": kind == "wallet", "span2": kind == "wallet" and not run.won}
                for label, value, color, kind in stats
            ],
            "reach": (ctx.text(Text.upgrades_in_reach, count=reach) if reach > 0 else ctx.text(Text.every_coin_counts)),
        }
