"""Panels. The title, garage and HUD are listed by their scenes; pause exists on track
scenes and follows its key, and the results follow the race."""

import math

from parallax import Panel, Settings, SettingsPanel, WorldBar, close_panel, load_scene, open_panel, reload_scene, ui
from parallax.hud import MinimapPanel
from parallax.vehicles import Drivetrain, Vehicle
from project import Scenes, Text

from game import garage
from game.actions import DriveControls
from game.components import Nitro, PlayerCar, Racer, TrackScene
from game.config import RaceRules
from game.content import CarDef, DifficultyDef, PartDef, RoundDef, TimeOfDayDef, TrackDef, WeatherDef
from game.formatting import format_time
from game.resources import Career, GarageMenu, Race, RacePhase, RacePlan, RaceResult, Season
from game.rules import current_round, installed_tier, is_racing, owns, racing_line
from game.track import laps_done


def place_text(ctx, place):
    return ctx.text(Text.position, place=place, total=ctx.world.query(Racer).count())


def set_quality(ctx, value: str):
    """The pause card's graphics switch."""
    ctx.get(Settings).quality = value


@ui("title_screen", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    actions = {"quick_race": garage.quick_race, "championship": garage.championship}

    def state(self, ctx):
        titles = ctx.get(Career).titles
        return {"trophies": ctx.text(Text.trophies, count=titles) if titles else ctx.text(Text.awaiting_green)}


ICONS = {
    "engine": "M4 9h3l2-3h6v3h3l2 2v6h-3l-2 2H8l-2-3H4z",
    "tires": "M12 3a9 9 0 1 0 0.01 0zM12 8.5a3.5 3.5 0 1 0 0.01 0zM12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21",
    "brakes": "M11 5a8 8 0 1 0 0.01 0zM11 10.5a2.5 2.5 0 1 0 0.01 0zM14.5 3.6a10 10 0 0 1 6 6.2",
    "nitro": "M10 8h4a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3zM10 8V4.5h4V8M8.5 3.5h7M10 14.5h4",
}


def on_screen(screen: str):
    return lambda ctx: ctx.get(GarageMenu).screen == screen


def money(n: int) -> str:
    return f"{round(n):,}"


def stat_score(value: float, lo: float, hi: float) -> int:
    return max(1, min(10, round((value - lo) / (hi - lo) * 10)))


def season_card(ctx):
    """The championship round card the template's car select carries."""
    round_ = current_round(ctx).data
    meta = " · ".join([ctx.text(Text.laps_n, laps=round_.laps), ctx.text(round_.weather.data.name), ctx.text(round_.time_of_day.data.name)])
    return {
        "season_kick": ctx.text(Text.season_kicker, number=round_.number, total=len(ctx.content(RoundDef))),
        "season_name": ctx.text(round_.name),
        "season_meta": meta,
        "season_body": f"{ctx.text(round_.track.data.name)} · {meta}. {ctx.text(round_.blurb)}",
    }


@ui("car_select", html="ui/car_select.html", modal=True, layer="menu", scenes=[Scenes.garage], when=on_screen("car"))
class CarSelect(Panel):
    """Select Your Car: the arrows inspect the lineup on the grass, a locked car shows
    its price and Buy, Garage fits parts, Next goes on with a car you own."""

    actions = {
        "previous_car": garage.previous_car, "next_car": garage.next_car, "buy_car": garage.buy_shown_car,
        "back": load_scene(Scenes.title), "garage": garage.to_garage_shop, "next": garage.leave_car_select,
    }

    def state(self, ctx):
        career = ctx.get(Career)
        cars = list(ctx.content(CarDef))
        car = garage.shown_car(ctx)
        owned = owns(ctx, car)
        price = car.data.price
        short = not owned and price > career.credits
        state = {
            "credits": money(career.credits),
            "titles": career.titles,
            "no_titles": career.titles == 0,
            "no_season": not ctx.get(RacePlan).championship,
            "name": ctx.text(car.data.name),
            "desc": ctx.text(car.data.blurb),
            "count": f"{cars.index(car) + 1} / {len(cars)}",
            "owned": owned,
            "locked": not owned,
            "badge": ctx.text(Text.owned if owned else Text.locked),
            "no_price": owned or price == 0,
            "short": short,
            "affordable": not short,
            "price": f"{money(price)} CR",
            "short_text": ctx.text(Text.credits_short, credits=money(price - career.credits)) if short else "",
            "buy_label": ctx.text(Text.buy_for, price=money(price)),
        }
        for key, value in (("speed", stat_score(car.data.top_speed, 20, 36)),
                           ("accel", stat_score(car.data.acceleration, 30, 45)),
                           ("handling", stat_score(car.data.handling, 80, 145))):
            state[key] = value
            state[f"{key}_segs"] = [{"on": i < value and i < 8, "top": i < value and i >= 8} for i in range(10)]
        state.update(season_card(ctx) if ctx.get(RacePlan).championship else
                     {"season_kick": "", "season_name": "", "season_meta": "", "season_body": ""})
        return state


@ui("garage_shop", html="ui/garage_shop.html", modal=True, layer="menu", scenes=[Scenes.garage], when=on_screen("garage"))
class GarageShop(Panel):
    """Garage: one card per part with its three-step tier track, the next tier and an
    amber Buy, or MAXED."""

    actions = {"buy_part": garage.buy_part, "back": garage.to_car_select}

    def state(self, ctx):
        career = ctx.get(Career)
        return {
            "credits": money(career.credits),
            "car": ctx.text(Text.fitting, car=ctx.text(career.car.data.name)),
            "parts": [self.part_card(ctx, part) for part in ctx.content(PartDef)],
        }

    def part_card(self, ctx, part):
        career = ctx.get(Career)
        tiers = part.data.tiers
        level = career.part_tiers.get(part.id, 0)
        current = tiers[level]
        upgrade = tiers[level + 1] if level + 1 < len(tiers) else None
        shown = upgrade or current
        return {
            "part": part.id,
            "icon": ICONS.get(part.id.split(".")[-1], ""),
            "name": ctx.text(part.data.name),
            "tier_label": ctx.text(Text.tier_of, tier=level + 1, tiers=len(tiers), name=ctx.text(current.name)),
            "desc": ctx.text(part.data.blurb),
            "steps": [{"name": ctx.text(t.name), "past": i < level, "now": i == level} for i, t in enumerate(tiers)],
            "next_label": ctx.text(Text.next_tier if upgrade else Text.installed),
            "next_name": ctx.text(shown.name),
            "next_blurb": ctx.text(shown.blurb),
            "maxed": upgrade is None,
            "buyable": upgrade is not None,
            "affordable": upgrade is not None and career.credits >= upgrade.price,
            "short": upgrade is not None and career.credits < upgrade.price,
            "price": f"{money(upgrade.price)} CR" if upgrade else "",
        }


@ui("map_select", html="ui/map_select.html", modal=True, layer="menu", scenes=[Scenes.garage], when=on_screen("track"))
class MapSelect(Panel):
    """Select a Track: the championship calendar strip and one card per circuit with its
    difficulty chip, default laps and best lap; a round picks its own track."""

    actions = {"pick_track": garage.pick_map, "back": garage.to_car_select, "next": garage.to_race_settings}

    def state(self, ctx):
        plan = ctx.get(RacePlan)
        season = plan.championship
        records = ctx.get(Career).best_laps
        rounds = list(ctx.content(RoundDef))
        now = ctx.get(Season).round
        picked = current_round(ctx).data.track if season else plan.track
        tracks = []
        for i, track in enumerate(ctx.content(TrackDef)):
            best = records.get(track.id, 0)
            selected = track == picked
            dim = season and not selected
            tracks.append({
                "track": track.id, "number": f"{i + 1:02d}", "name": ctx.text(track.data.name), "desc": ctx.text(track.data.blurb),
                "difficulty": ctx.text(Text.difficulty_chip, level=track.data.difficulty.capitalize()),
                "diff_easy": track.data.difficulty == "easy", "diff_medium": track.data.difficulty == "medium",
                "diff_hard": track.data.difficulty == "hard",
                "laps": track.data.laps, "best": format_time(best) if best else ctx.text(Text.no_record),
                "has_record": best > 0, "no_record": best <= 0,
                "selected": selected, "not_selected": not selected, "dim": dim, "not_dim": not dim,
            })
        calendar = []
        if season:
            for i, r in enumerate(rounds):
                x2 = r.data.points_scale > 1
                meta = [ctx.text(r.data.track.data.name), ctx.text(Text.laps_n, laps=r.data.laps)]
                meta += [ctx.text(Text.double_points)] if x2 else [ctx.text(r.data.weather.data.name), ctx.text(r.data.time_of_day.data.name)]
                calendar.append({
                    "tag": f"R{i + 1}", "name": ctx.text(r.data.name), "meta": " · ".join(meta),
                    "done": i < now, "now": i == now, "not_done": not i < now, "not_now": i != now or i < now,
                    "not_x2": not x2 or i <= now, "x2": f"×{r.data.points_scale:g} pts",
                })
        return {
            "season_mode": season,
            "kicker": ctx.text(Text.season_kicker, number=now + 1, total=len(rounds)) if season else ctx.text(Text.brand),
            "sub": ctx.text(Text.round_picks_track if season else Text.choose_circuit),
            "tracks": tracks,
            "calendar": calendar,
        }


@ui("race_settings", html="ui/race_settings.html", modal=True, layer="menu", scenes=[Scenes.garage], when=on_screen("settings"))
class RaceSettings(Panel):
    """Race Settings: Laps, Opponents, Difficulty (with its payout), Time of Day and
    Weather as segmented rows; a championship round locks all but the difficulty."""

    actions = {"set_option": garage.set_option, "back": garage.to_map_select, "start": garage.race}

    def state(self, ctx):
        plan = ctx.get(RacePlan)
        season = plan.championship
        round_ = current_round(ctx).data
        tuning = ctx.config(RaceRules)
        career = ctx.get(Career)
        laps = round_.laps if season else plan.laps
        opponents = round_.opponents if season else plan.opponents
        weather = round_.weather if season else plan.weather
        hour = round_.time_of_day if season else plan.time_of_day
        levels = list(ctx.content(DifficultyDef))
        top = max(levels, key=lambda level: level.data.payout_scale)
        payout = ctx.text(Text.payout, scale=f"{career.difficulty.data.payout_scale:.1f}")
        if top != career.difficulty:
            payout += " · " + ctx.text(Text.pays, name=ctx.text(top.data.name), scale=f"{top.data.payout_scale:.1f}")
        set_by = ctx.text(Text.set_by_round, number=round_.number)

        def row(key, label, note, options, current, lockable=True):
            locked = season and lockable
            return {
                "label": ctx.text(label), "note": set_by if locked else note, "locked": locked, "unlocked": not locked,
                "options": [{"row": key, "value": str(value), "label": text, "on": value == current, "locked": locked,
                             "no_padlock": not (locked and value == current)} for value, text in options],
            }

        return {
            "sub": ctx.text(Text.settings_season_sub if season else Text.settings_sub),
            "no_season": not season,
            "lock_note": ctx.text(Text.round_locks, name=ctx.text(round_.name)),
            "lock_note_short": ctx.text(Text.round_locks_short, number=round_.number),
            "rows": [
                row("laps", Text.laps_row, "", [(n, str(n)) for n in tuning.lap_options], laps),
                row("opponents", Text.opponents_row, "", [(n, str(n)) for n in tuning.opponent_options], opponents),
                row("difficulty", Text.difficulty_row, payout,
                    [(level.id, ctx.text(level.data.name)) for level in levels], career.difficulty.id, lockable=False),
                row("time_of_day", Text.time_row, "", [(t.id, ctx.text(t.data.name)) for t in ctx.content(TimeOfDayDef)], hour.id),
                row("weather", Text.weather_row, ctx.text(Text.wet_note),
                    [(w.id, ctx.text(w.data.name)) for w in ctx.content(WeatherDef)], weather.id),
            ],
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu",
    scenes=[TrackScene], toggle_with=DriveControls.pause)
class PauseMenu(Panel):
    """Race paused: Resume, Main Menu and the template's Low / Medium / High switch."""

    actions = {"resume": close_panel(), "main_menu": load_scene(Scenes.title), "quality": set_quality}

    def state(self, ctx):
        _, racer = ctx.world.query(Racer, tagged=PlayerCar).single()
        race = ctx.get(Race)
        current = ctx.get(Settings).quality
        return {
            "place": place_text(ctx, racer.place),
            "round": ctx.text(race.round.data.name) if race.round is not None else ctx.text(race.track.data.name),
            "qualities": [
                {"value": q, "label": ctx.text(label), "on": q == current, "pressed": "true" if q == current else "false"}
                for q, label in (("low", Text.quality_low), ("medium", Text.quality_medium), ("high", Text.quality_high))
            ],
        }


SUFFIX = ["TH", "ST", "ND", "RD"]
SHIFT_COLORS = ["#fbbf24", "#fbbf24", "#f97316", "#f97316", "#ff4d2e"]
RESPAWN_RING = 301.6  # the ring's circumference (r = 48)
DIAL_MAX = 8  # the tach face, x1000 rpm (ui/hud.html draws its ticks for this)


def place_suffix(n: int) -> str:
    return "TH" if 11 <= n % 100 <= 13 else (SUFFIX[n % 10] if n % 10 < 4 else "TH")


def clock(seconds: float) -> str:
    """The dashboard's clocks: 0:00.00 until running."""
    return format_time(seconds) if seconds > 0 else "0:00.00"


def dial_point(value: float, radius: float):
    a = math.radians(135 + 270 * value / DIAL_MAX)
    return 150 + radius * math.cos(a), 150 + radius * math.sin(a)


def dial_arc(v1: float, v2: float, radius: float = 132) -> str:
    (ax, ay), (bx, by) = dial_point(v1, radius), dial_point(v2, radius)
    large = 1 if 270 * (v2 - v1) / DIAL_MAX > 180 else 0
    return f"M{ax:.1f} {ay:.1f} A{radius} {radius} 0 {large} 1 {bx:.1f} {by:.1f}"


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """The template's motorsport dashboard: position badge and lap plate, the round
    strip, lap / best / total times, the nitro tank, wheelspin and drift chips, the
    speed and a tachometer driven by the real drivetrain."""

    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        car, racer = ctx.world.query(Racer, tagged=PlayerCar).single()
        driver, nitro = ctx.world.query(Nitro).single()
        race = ctx.get(Race)
        hold = driver.get(WorldBar).value
        laps = race.laps
        tuning = ctx.config(RaceRules)
        vehicle = car.get(Vehicle)
        speed = round(abs(vehicle.speed) * 3.6)
        record_on_file = ctx.get(Career).best_laps.get(str(race.track.id), 0)
        record = 0 < racer.best_lap and (not record_on_file or racer.best_lap < record_on_file - 0.005)
        charge = nitro.charge / nitro.capacity
        mode = "active" if nitro.active else ("ready" if nitro.charge >= tuning.nitro_min_charge else "charging")
        total = ctx.world.query(Racer).count()
        place = racer.place
        has_round = race.round is not None
        return {
            "pos_num": str(place),
            "pos_suffix": place_suffix(place),
            "pos_total": f"/ {total}",
            "lap_current": min(laps, laps_done(racing_line(ctx), racer) + 1),
            "lap_max": laps,
            "has_round": has_round,
            "round_name": ctx.text(race.round.data.name) if has_round else "",
            "round_n": f"{ctx.get(Season).round + 1}/{len(ctx.content(RoundDef))}" if has_round else "",
            "lap_time": clock(ctx.time.now - racer.lap_started_at if is_racing(ctx) else 0),
            "race_time": clock(ctx.time.now - race.started_at if is_racing(ctx) else 0),
            "best_lap": format_time(racer.best_lap) if racer.best_lap > 0 else "--:--.--",
            "record": record,
            "best_cell_label": ctx.text(Text.record_label if record else Text.best_label),
            "has_ghost": race.ghost_best >= 0,
            "ghost_best": format_time(race.ghost_best) if race.ghost_best > 0 else "--:--.--",
            "wrong_way": racer.wrong_way_for > tuning.wrong_way_after,
            "nitro_mode": mode,
            "nitro_pct": f"{round(charge * 100)}%",
            "nitro_width": f"{charge * 100:.1f}%",
            "nitro_mark": f"{tuning.nitro_min_charge / nitro.capacity * 100:.1f}%",
            "drifting": vehicle.drifting,
            "wheelspin": vehicle.skidding and not vehicle.drifting,
            "speed": speed,
            "speed_bar": f"{min(100, speed / 220 * 100):.1f}%",
            "respawn_active": 0 < hold < 1,
            "respawn_ring": f"{RESPAWN_RING * hold:.1f} {RESPAWN_RING}",
            **self.tachometer(car),
        }

    def tachometer(self, car):
        """The real drivetrain's revs and gear: the needle and sweep, the redline band
        from the car's own limiter, five shift lights over the last 1500 rpm, and the
        24-segment strip the touch layout shows."""
        drivetrain = car.get(Drivetrain)
        rpm = max(0.0, drivetrain.rpm)
        value = min(DIAL_MAX, rpm / 1000)
        red = min(DIAL_MAX, (drivetrain.redline_rpm - 500) / 1000)
        lit = round(24 * value / DIAL_MAX)
        red_from = round(24 * red / DIAL_MAX)
        start = drivetrain.redline_rpm - 2000
        return {
            "tach_needle": f"rotate({135 + 270 * value / DIAL_MAX:.1f} 150 150)",
            "tach_sweep": dial_arc(0, min(value, red)) if value > 0.05 else "",
            "tach_red": dial_arc(red, DIAL_MAX),
            "gear": "R" if drivetrain.gear < 0 else ("N" if drivetrain.gear == 0 else str(drivetrain.gear)),
            "rpm_text": f"{round(rpm):,} RPM",
            "shift_lights": [{"on": rpm >= start + i * 375, "color": c} for i, c in enumerate(SHIFT_COLORS)],
            "rpm_segs": [{"on": i < lit, "red": i >= red_from} for i in range(24)],
        }


@ui("race_minimap", html="ui/minimap.html", layer="hud", scenes=[TrackScene])
class RaceMinimap(MinimapPanel):
    """The engine minimap as the kit's dark ring, under the times plate."""


@ui("results", html="ui/results.html", modal=True, layer="menu",
    scenes=[TrackScene], when=lambda ctx: ctx.get(Race).phase is RacePhase.FINISHED)
class ResultsPanel(Panel):
    actions = {"garage": load_scene(Scenes.garage), "retry": reload_scene(), "next_round": garage.next_round}

    def state(self, ctx):
        result = ctx.get(RaceResult)
        ghost = ctx.get(Race).ghost_best
        return {
            "title": ctx.text(self.title(result)),
            "place": ctx.text(Text.position, place=result.place, total=len(result.rows)),
            "rows": [
                {
                    "place": index + 1,
                    "name": self.name(ctx, row.car, row.is_player),
                    "time": format_time(row.time) if row.finished else ctx.text(Text.on_track),
                    "points": row.points,
                    "is_player": row.is_player,
                }
                for index, row in enumerate(result.rows)
            ],
            "standings": [
                {"name": self.name(ctx, row.car, row.is_player), "points": row.points, "is_player": row.is_player}
                for row in result.standings
            ],
            "race_time": format_time(result.race_time),
            "best_lap": format_time(result.best_lap),
            "championship": result.championship,
            "has_next_round": result.has_next_round,
            "credits": result.credits_earned,
            "wallet": ctx.get(Career).credits,
            "lap_record": result.lap_record,
            "season_over": result.season_over,
            "ghost_beaten": ghost < 0 or result.race_time < ghost,
            "had_ghost": ghost >= 0,
            "ghost_time": format_time(max(0, ghost)),
        }

    def title(self, result):
        if result.season_over:
            return Text.champion if result.champion else Text.season_lost
        if result.place == 1:
            return Text.first_place
        return Text.podium if result.place <= 3 else Text.race_complete

    def name(self, ctx, car, is_player):
        return ctx.text(Text.you_in, car=ctx.text(car.data.name)) if is_player else ctx.text(car.data.name)
