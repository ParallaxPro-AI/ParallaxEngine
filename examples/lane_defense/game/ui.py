"""Panels: title (garden map), HUD, pause menu and result card, laid out as the template's
(ui/garden.css carries its styles). Each one opens from state or input; no system opens
or closes a panel."""

import math

from parallax import Context, Panel, Settings, close_panel, field, load_scene, open_panel, resource, ui
from project import Scenes, Text

from game.actions import GardenControls
from game.arming import arm_seed, arm_trowel, arm_watering_can, disarm
from game.checkpoint import can_continue, continue_garden
from game.components import Husk, Planted
from game.config import GardenRules
from game.content import LevelDef, PlantDef
from game.gardens import choose_level, is_unlocked, next_garden, plant_next_garden, replant
from game.lawn import current_level, husk_count
from game.notes import GardenNotes
from game.resources import Campaign, GardenState, Irrigation, Planting, Pollen, Result, Tool, WaveState

QUIT = load_scene(Scenes.title, new_run=True)


@resource("menus", keep="session")
class Menus:
    how_open: bool = field(True, doc="The title's how-to-play section is unfolded (as on a desktop).")


def toggle_how(ctx: Context) -> None:
    menus = ctx.get(Menus)
    menus.how_open = not menus.how_open


def plant_named_in(ctx: Context, text: str) -> PlantDef | None:
    """The seed a reward line names ("Barkshell + irrigation" → Barkshell), as the template
    matched its reward art."""
    lowered = text.lower()
    for plant in ctx.content(PlantDef):
        if ctx.text(plant.data.name).lower() in lowered:
            return plant.data
    return None


def stars_text(stars: int) -> str:
    return "★" * stars + "☆" * (3 - stars)


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {
        "choose_level": choose_level,
        "start": replant,
        "continue": continue_garden,
        "toggle_how": toggle_how,
    }

    def state(self, ctx):
        campaign = ctx.get(Campaign)
        levels = []
        selected = {}
        for level in ctx.content(LevelDef):
            stars = campaign.stars.get(level, 0)
            locked = not is_unlocked(ctx, level)
            entry = {
                "level": level.id,
                "badge": f"{level.data.number:02d}",
                "title": ctx.text(level.data.title),
                "cap": stars_text(stars) if stars else ctx.text(Text.locked) if locked else ctx.text(Text.ready_to_grow),
                "starred": stars > 0,
                "locked": locked,
                "selected": level == campaign.level,
            }
            levels.append(entry)
            if entry["selected"]:
                reward = ctx.text(level.data.reward)
                plant = plant_named_in(ctx, reward)
                selected = {
                    "number": ctx.text(Text.garden_number, number=entry["badge"]),
                    "title": entry["title"],
                    "subtitle": ctx.text(level.data.subtitle),
                    "reward_label": ctx.text(Text.grown_here if stars else Text.grow_next),
                    "reward": reward,
                    "reward_art": f"ld-a-{plant.art}" if plant else "",
                }
        return {
            "levels": levels,
            "selected": selected,
            "can_continue": can_continue(ctx),
            "how_open": ctx.get(Menus).how_open,
            "reduced_motion": ctx.get(Settings).reduced_motion,
        }


def toggle_sound(ctx: Context) -> None:
    """The pause menu's sound switch: mute, or back to full volume."""
    settings = ctx.get(Settings)
    settings.master_volume = 0.0 if settings.master_volume > 0 else 1.0


def toggle_motion(ctx: Context) -> None:
    """The pause menu's motion switch: reduced motion holds the garden characters still."""
    settings = ctx.get(Settings)
    settings.reduced_motion = not settings.reduced_motion


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.garden],
    toggle_with=GardenControls.pause)
class PauseMenu(Panel):
    actions = {
        "resume": close_panel(),
        "toggle_sound": toggle_sound,
        "toggle_motion": toggle_motion,
        "quit": QUIT,
    }

    def state(self, ctx):
        settings = ctx.get(Settings)
        sound, reduced = settings.master_volume > 0, settings.reduced_motion
        return {
            "sound_on": sound,
            "sound_pressed": "true" if sound else "false",
            "reduced_motion": reduced,
            "motion_full_disabled": not reduced,
            "motion_full": "false" if reduced else "true",
            "motion_reduced": "true" if reduced else "false",
        }


def health_color(percent: float) -> str:
    if percent > 50:
        return "var(--ld-leaf)"
    return "var(--ld-gold)" if percent > 25 else "var(--ld-danger)"


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {
        "choose_seed": arm_seed,
        "water": arm_watering_can,
        "dig": arm_trowel,
        "cancel": disarm,
        "pause": open_panel(PauseMenu),
    }

    def state(self, ctx):
        level = current_level(ctx)
        planting, waves, garden = ctx.get(Planting), ctx.get(WaveState), ctx.get(GardenState)
        notes, irrigation = ctx.get(GardenNotes), ctx.get(Irrigation)
        now, pollen = ctx.time.now, ctx.get(Pollen).amount
        wait = level.buildup if waves.wave == 0 else level.interval
        total = len(level.waves)
        seeds = []
        for slot, card in enumerate(level.cards, start=1):
            plant = card.data
            cooldown = max(0.0, planting.seed_ready_at.get(card, 0) - now)
            armed = planting.tool is Tool.SEED and planting.seed == card
            seeds.append({
                "plant": card.id,
                "key": slot,
                "name": ctx.text(plant.name),
                "cost": plant.cost,
                "tint": plant.tint,
                "art": f"art ld-a-{plant.art}",
                "armed": armed,
                "cooling": cooldown >= 0.05,
                "unready": not armed and (cooldown >= 0.05 or pollen < plant.cost),
                "broke": pollen < plant.cost,
                "recharge_label": f"{math.ceil(cooldown)}s",
                "veil": f"{min(100.0, cooldown / plant.recharge * 100) if plant.recharge else 0:.1f}%",
            })

        # The wave bar: done waves full, the current one filling toward the next.
        elapsed = now - waves.countdown_from
        husks = ctx.world.query(Husk).count()
        spawning = waves.wave > 0 and waves.spawned < husk_count(level, level.waves[waves.wave - 1])
        if waves.wave <= 0:
            progress = 0.0
        elif waves.wave >= total:
            progress = 1.0 if not spawning and husks == 0 else 0.5
        else:
            progress = min(1.0, elapsed / max(1.0, wait))
        segments = [
            {"fill": "100%" if i < waves.wave - 1 else f"{round(progress * 100)}%" if i == waves.wave - 1 else "0%"}
            for i in range(total)
        ]

        percent = max(0, min(100, round(garden.house_health / ctx.config(GardenRules).house_health * 100)))
        if waves.wave == 0 and level.waits_for_defender and not any(
                p.kind.data.defends for _, p in ctx.world.query(Planted)):
            status = ctx.text(Text.status_first_defender)
        elif spawning:
            status = ctx.text(Text.status_incoming, row=self.next_row(level, waves) + 1)
        else:
            status = ctx.text(Text.status_alive, count=husks, seconds=max(0, math.ceil(waves.countdown_from + wait - now)))

        water_wait = max(0.0, irrigation.ready_at - now)
        tool = planting.tool
        if water_wait > 0:
            water_label = f"{math.ceil(water_wait)}s"
        elif irrigation.row >= 0:
            water_label = ctx.text(Text.water_row_label, row=irrigation.row + 1)
        else:
            water_label = ctx.text(Text.water_free)
        return {
            "pollen": pollen,
            "wave_label": ctx.text(Text.wave_long, garden=level.number, wave=waves.wave, total=total),
            "wave_short": ctx.text(Text.wave_short, garden=level.number, wave=waves.wave, total=total),
            "level_title": ctx.text(level.title),
            "segments": segments,
            "health_label": f"{percent}%",
            "health_width": f"{percent}%",
            "health_color": health_color(percent),
            "status": status,
            "notice": notes.notice,
            "notice_shown": bool(notes.notice) and now < notes.notice_until,
            "danger": notes.danger,
            "message": notes.message if now < notes.message_until else "",
            "seeds": seeds,
            "trowel_key": len(level.cards) + 1,
            "trowel_armed": tool is Tool.DIG,
            "irrigation": level.irrigation,
            "water_armed": tool is Tool.WATER,
            "water_live": water_wait <= 0 and irrigation.row >= 0 and tool is not Tool.WATER,
            "water_unready": water_wait > 0 and tool is not Tool.WATER,
            "water_label": water_label,
            "armed": tool is not Tool.NONE,
            "divider": level.irrigation or tool is not Tool.NONE,
            "reduced_motion": ctx.get(Settings).reduced_motion,
        }

    def next_row(self, level: LevelDef, waves: WaveState) -> int:
        """The lane the next husk of a cycling wave takes (the template's "Incoming · row N")."""
        return level.lanes[waves.lane_turn % len(level.lanes)]


@ui("result_screen", html="ui/result.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(GardenState).result is not Result.PLAYING)
class ResultScreen(Panel):
    actions = {"next": plant_next_garden, "retry": replant, "quit": QUIT}

    def state(self, ctx):
        garden, campaign = ctx.get(GardenState), ctx.get(Campaign)
        level = campaign.level.data
        won = garden.result is Result.WON
        reward = ctx.text(level.reward)
        plant = plant_named_in(ctx, reward)
        has_next = won and next_garden(ctx, campaign.level) is not None
        return {
            "won": won,
            "lost": not won,
            "eyebrow": ctx.text(Text.result_eyebrow, number=level.number, title=ctx.text(level.title)),
            "headline": ctx.text(Text.garden_saved if won else Text.garden_overrun),
            "stars": [{"lit": i < garden.stars} for i in range(3)],
            "score_line": ctx.text(Text.result_score, kills=garden.kills, score=f"{garden.score:,}"),
            "unlock": won and bool(reward),
            "unlock_name": ctx.text(Text.unlocked, reward=reward),
            "unlock_art": f"ld-a-{plant.art}" if plant else "",
            "unlock_tint": plant.tint if plant else "#edbd58",
            "unlock_blurb": f"{ctx.text(plant.blurb)} · ✺ {plant.cost}" if plant else "",
            "has_next": has_next,
            "no_next": not has_next,
            "reduced_motion": ctx.get(Settings).reduced_motion,
        }
