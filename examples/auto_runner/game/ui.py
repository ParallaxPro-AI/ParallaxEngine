"""Panels, ported from the template's HTML/CSS (ui/kit.css is its kit: Anton + Nunito,
the --cd-* tokens, the skewed buttons): title, HUD, the Outfitter, pause, and the two end
cards (wiped out / the far rim), plus the menu actions that need logic."""

from parallax import Panel, Settings, close_panel, load_scene, open_panel, reload_scene, ui
from parallax.combat import Health
from project import Scenes, Text

from game.actions import Controls
from game.components import Obstacle, Runner
from game.config import Canyon
from game.content import OutfitDef, StageDef
from game.profile import bank, buy, can_buy, equip
from game.resources import Profile, Run


KMH_PER_SPEED = 18  # the HUD's arcade speedometer: world m/s × 18, as the template shows it


def play(ctx, endless: bool):
    """Start a run. Endless is honoured only once it's unlocked; the mode is a
    session choice, so "Run again" keeps it."""
    run = Run(endless=endless and ctx.get(Profile).endless_unlocked)
    ctx.scenes.load(Scenes.canyon, new_run=True, init=[run])


def abandon(ctx):
    """Quit from the pause menu. The half-run is still banked."""
    bank(ctx, won=False)
    ctx.scenes.load(Scenes.title, new_run=True)


def best_for(ctx, run: Run) -> int:
    profile = ctx.get(Profile)
    return profile.best_endless if run.endless else profile.best_journey


def end_card_due(ctx) -> bool:
    """The run is over and its beat has passed."""
    run = ctx.get(Run)
    return run.over and ctx.time.now >= run.card_at


QUALITIES = ("low", "medium", "high")
BANNER_SECONDS = 2.6


def set_quality(ctx, quality: str) -> None:
    """The pause card's Graphics Low / Medium / High."""
    if quality in QUALITIES:
        ctx.get(Settings).quality = quality


def set_volume(ctx, value: float) -> None:
    """The pause card's Volume slider (0..1)."""
    ctx.get(Settings).master_volume = min(max(value, 0.0), 1.0)


def pause_state(ctx) -> dict:
    settings = ctx.get(Settings)
    state = {f"quality_{q}": "true" if settings.quality == q else "false" for q in QUALITIES}
    state["volume"] = str(round(settings.master_volume * 100))
    return state


def metres(n: float) -> str:
    return f"{int(n):,} m"


@ui("outfitter", html="ui/outfitter.html", modal=True, layer="menu")
class Outfitter(Panel):
    actions = {"buy": buy, "equip": equip, "close": close_panel()}

    def state(self, ctx):
        profile = ctx.get(Profile)
        return {
            "wallet": f"{profile.wallet:,}",
            "outfits": [
                {
                    "outfit": outfit.id,
                    "name": ctx.text(outfit.data.name),
                    "blurb": ctx.text(outfit.data.blurb),
                    "cost": f"{outfit.data.cost:,}",
                    "swatch": outfit.data.swatch.to_hex(),
                    "owned": outfit in profile.owned,
                    "not_owned": outfit not in profile.owned,
                    "equipped": outfit == profile.outfit,
                    "can_equip": outfit in profile.owned and outfit != profile.outfit,
                    "buy_label": ctx.text(Text.outfitter_buy if can_buy(profile, outfit) else Text.outfitter_locked),
                }
                for outfit in ctx.content(OutfitDef)
            ],
        }


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"play": play, "outfits": open_panel(Outfitter)}

    def state(self, ctx):
        profile = ctx.get(Profile)
        return {
            "best_journey": metres(profile.best_journey),
            "best_endless": metres(profile.best_endless),
            "has_best": profile.best_journey > 0,
            "has_best_endless": profile.endless_unlocked and profile.best_endless > 0,
            "endless_unlocked": profile.endless_unlocked,
            "wallet": f"{profile.wallet:,}",
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.canyon], toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quit": abandon, "quality": set_quality, "volume": set_volume}

    def state(self, ctx):
        return pause_state(ctx)


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        run = ctx.get(Run)
        cfg = ctx.config(Canyon)
        stages = ctx.content(StageDef)
        _, health = ctx.world.query(Health, tagged=Runner).single()
        to_next = cfg.streak_step - run.streak % cfg.streak_step
        maxed = run.multiplier >= cfg.max_multiplier
        filled = cfg.streak_step if maxed else cfg.streak_step - to_next
        cue = self.tip(ctx, run)
        lead, _, rest = cue.partition(" · ")
        cap = cfg.endless_speed_cap if run.endless else stages[-1].data.speed_cap
        progress = 0.0 if run.endless else min(1.0, run.distance / cfg.goal_distance)
        return {
            "endless": run.endless,
            "distance": metres(run.distance),
            "best": metres(best_for(ctx, run)),
            "progress": f"{progress * 100:.1f}%",
            "stage_marks": [] if run.endless else [
                {"at": f"{stage.data.from_distance / cfg.goal_distance * 100:.1f}%"}
                for stage in stages if 0 < stage.data.from_distance < cfg.goal_distance
            ],
            "coins": f"{run.coins:,}",
            "multiplier": f"×{run.multiplier}",
            "pips": [{"on": i < filled} for i in range(cfg.streak_step)],
            "to_next": ctx.text(Text.hud_maxed, value=run.multiplier) if maxed
            else ctx.text(Text.hud_to_next, coins=to_next, next=run.multiplier + 1),
            "hearts": [{"empty": i >= int(health.current)} for i in range(int(health.max))],
            "kmh": round(run.speed * KMH_PER_SPEED),
            "speed_bar": f"{min(1.0, run.speed / cap) * 100:.0f}%",
            "cue_lead": lead if rest else "",
            "cue_rest": rest if rest else cue,
            "stage": ctx.text(run.stage.data.name),
            "stage_sub": ctx.text(run.stage.data.subtitle),
            "stage_number": ctx.text(Text.hud_stage, number=stages.index(run.stage) + 1, count=len(stages)),
            "banner_on": ctx.time.now - run.stage_at < BANNER_SECONDS,
        }

    def tip(self, ctx, run: Run) -> str:
        """The verb for the hazard about to arrive, else the latest praise."""
        runner_x = ctx.config(Canyon).runner_x
        ahead = [
            (entity.transform.position.x, obstacle.kind)
            for entity, obstacle in ctx.world.query(Obstacle)
            if entity.transform.position.x > runner_x
        ]
        if ahead:
            x, kind = min(ahead)
            if (x - runner_x) / max(1.0, run.speed) < 1.25:
                return ctx.text(kind.data.counter)
        return run.feedback if ctx.time.now < run.feedback_until else ctx.text(Text.tip_follow_coins)


def wiped_out_due(ctx) -> bool:
    return end_card_due(ctx) and not ctx.get(Run).won


def far_rim_due(ctx) -> bool:
    return end_card_due(ctx) and ctx.get(Run).won


@ui("wipeout", html="ui/wipeout.html", modal=True, layer="menu", when=wiped_out_due)
class WipedOut(Panel):
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title, new_run=True)}

    def state(self, ctx):
        run = ctx.get(Run)
        killer = run.killer.data if run.killer else None
        verb = ctx.text(killer.counter).partition(" · ")[0] if killer else ""
        return {
            "subtitle": ctx.text(Text.over_got_you, hazard=ctx.text(killer.name), stage=ctx.text(run.stage.data.name))
            if killer else "the canyon got you",
            "distance": metres(run.distance),
            "coins": f"+{run.coins:,}",
            "wallet": f"{ctx.get(Profile).wallet:,}",
            "best_label": ctx.text(Text.over_best_endless if run.endless else Text.over_best),
            "best": metres(best_for(ctx, run)),
            "new_best": run.new_best,
            "journey": not run.endless,
            "to_rim": metres(max(0, ctx.config(Canyon).goal_distance - int(run.distance))),
            "lesson": verb in ("HOP", "DUCK"),
            "verb": verb,
            "verb_tail": "under it" if verb == "DUCK" else "it",
        }


@ui("far_rim", html="ui/victory.html", modal=True, layer="menu", when=far_rim_due)
class FarRim(Panel):
    actions = {"retry": reload_scene(new_run=True), "endless": play, "quit": load_scene(Scenes.title, new_run=True)}

    def state(self, ctx):
        run = ctx.get(Run)
        return {"distance": metres(run.distance), "coins": f"+{run.coins:,}"}
