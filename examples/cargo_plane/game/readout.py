"""What the flight HUD reads off the career, the job and the plane — the template's
hud_update, worked out from the world each frame and handed to the panel already
formatted (the panel only binds)."""

import math

from parallax import Context, Entity, clamp, deg
from parallax.physics import Rigidbody
from parallax.vehicles import Vehicle
from project import Text

from game.components import Cockpit
from game.config import FreightRules
from game.content import RankDef
from game.feed import Feed, Kind
from game.resources import Board, Career
from game.rules import (airframes_left, depot, depot_near, distance_text, flown, interactor, money, objective,
                        plane_in_reach, rank)


def u(design_px: float) -> str:
    """A length in the panels' 1920 x 1080 design pixels (ui/sky_freight.css `--u`)."""
    return f"calc(var(--u) * {design_px})"


def career_strip(ctx: Context) -> dict:
    career = ctx.get(Career)
    rules = ctx.config(FreightRules)
    left = airframes_left(ctx)
    pct = round(clamp(career.money / rules.payoff_target, 0, 1) * 100)
    return {
        "bank": money(career.money),
        "rank": ctx.text(rank(ctx).data.name),
        "rank_level": len(ctx.content(RankDef).where(lambda rung: rung.deliveries <= career.deliveries)),
        "deliveries": career.deliveries,
        "loan_of": f"/ {money(rules.payoff_target)} · {pct}%",
        "loan_pct": f"{pct}%",
        "pips": [{"on": i < left} for i in range(rules.max_airframes)],
        "fleet": f"{left} / {rules.max_airframes}",
    }


def objective_line(ctx: Context) -> dict:
    board = ctx.get(Board)
    island = objective(ctx)
    if island is None:
        return {"obj_text": ctx.text(Text.objective_office), "obj_tag": "", "obj_color": "", "obj_distance": ""}
    here = interactor(ctx).transform.position
    cargo = ctx.text(board.contract.cargo.data.name)
    key, tag, color = ((Text.objective_deliver, Text.tag_deliver, "#2ee06a") if board.loaded
                       else (Text.objective_pickup, Text.tag_pickup, "#ffbe2e"))
    return {
        "obj_text": ctx.text(key, cargo=cargo, island=ctx.text(island.data.name)),
        "obj_tag": ctx.text(tag),
        "obj_color": color,
        "obj_distance": distance_text((depot(ctx, island).transform.position - here).flat().length()),
    }


def deadline(ctx: Context) -> dict:
    board = ctx.get(Board)
    if not board.loaded:
        return {"dl_shown": False, "dl_late": False, "dl_label": "", "dl_width": "0%"}
    seconds = math.ceil(board.time_left)
    total = board.contract.deadline
    return {
        "dl_shown": True,
        "dl_late": board.late or board.time_left < ctx.config(FreightRules).deadline_warning,
        "dl_label": ctx.text(Text.late) if seconds <= 0 else f"{seconds // 60}:{seconds % 60:02d}",
        "dl_width": f"{clamp(board.time_left / total, 0, 1) * 100:.1f}%" if total > 0 else "0%",
    }


def toasts(ctx: Context) -> list[dict]:
    return [{"text": line.text, "good": line.kind is Kind.GOOD, "bad": line.kind is Kind.BAD}
            for line in ctx.get(Feed).lines]


PROMPTS = {"board": Text.prompt_board, "exit": Text.prompt_exit, "land": Text.prompt_land}
PHASES = {"parked": Text.phase_parked, "taxi": Text.phase_taxi, "takeoff_roll": Text.phase_takeoff_roll,
          "climb": Text.phase_climb, "cruise": Text.phase_cruise, "descent": Text.phase_descent,
          "stall": Text.phase_stall}


def prompt_kind(ctx: Context, seat: Entity | None) -> str:
    """E's prompt: board a plane in reach, step out of a stopped one, or (still rolling
    out after a landing) brake to a stop first. Nothing in the air."""
    if seat is None:
        return "board" if plane_in_reach(ctx) is not None else ""
    vehicle = seat.get(Vehicle)
    if not vehicle.grounded:
        return ""
    return "exit" if abs(vehicle.speed) < ctx.config(FreightRules).exit_speed else "land"


def office_open_here(ctx: Context) -> bool:
    """Beside a depot pad: B opens the office (on foot, or in a plane on the ground)."""
    seat = flown(ctx)
    near = depot_near(ctx, interactor(ctx).transform.position, ctx.config(FreightRules).office_radius) is not None
    return near and (seat is None or seat.get(Vehicle).grounded)


def prompts(ctx: Context, seat: Entity | None, kind: str) -> dict:
    return {
        "prompt": ctx.text(PROMPTS[kind]) if kind else "",
        "prompt_plain": kind == "land",
        "landing_rollout": kind == "land",
        "office_prompt": office_open_here(ctx),
    }


def angle_of_attack(plane: Entity) -> float:
    velocity = plane.get(Rigidbody).velocity
    along = velocity.dot(plane.transform.forward)
    if velocity.length() < 1 or along <= 0:
        return 0.0
    return deg(math.atan2(-velocity.dot(plane.transform.up), along))


def stall_state(ctx: Context, plane: Entity | None) -> tuple[bool, bool]:
    """(warning, stalled): warn on a high angle of attack or low airspeed while airborne,
    before the wing actually lets go."""
    if plane is None or not plane.get(Vehicle).airborne:
        return False, False
    rules = ctx.config(FreightRules)
    vehicle = plane.get(Vehicle)
    near = angle_of_attack(plane) > rules.stall_warning_aoa or vehicle.speed < rules.stall_ref_speed * rules.stall_margin
    return near or vehicle.stalled, vehicle.stalled


def alert(ctx: Context, plane: Entity | None) -> dict:
    warning, stalled = stall_state(ctx, plane)
    return {"alert_shown": warning, "alert_stall": stalled,
            "alert_text": ctx.text(Text.stall if stalled else Text.stall_warning)}


def phase(ctx: Context, plane: Entity, climb: float) -> str:
    vehicle = plane.get(Vehicle)
    if vehicle.stalled and vehicle.airborne:
        return "stall"
    if vehicle.grounded:
        if abs(vehicle.speed) < 2:
            return "parked"
        return "takeoff_roll" if vehicle.speed >= ctx.config(FreightRules).rotate_speed * 0.5 else "taxi"
    if climb > 2.5:
        return "climb"
    return "descent" if climb < -2.5 else "cruise"


def phase_hint(ctx: Context, plane: Entity, now: str, prompt: str) -> str:
    """The line under the flight phase: what to do next."""
    rules = ctx.config(FreightRules)
    warning, stalled = stall_state(ctx, plane)
    if stalled:
        return ctx.text(Text.hint_stalled)
    if warning:
        return ctx.text(Text.hint_stall_warning)
    if now == "parked":
        return ctx.text(Text.hint_parked_exit if prompt == "exit" else Text.hint_parked)
    if now in ("taxi", "takeoff_roll"):
        if prompt == "land":
            return ctx.text(Text.hint_brake)
        return ctx.text(Text.hint_rotate, speed=round(rules.rotate_speed * 3.6))
    if now == "climb":
        return ctx.text(Text.hint_climb, speed=round(rules.stall_ref_speed * 3.6 * rules.stall_margin / 10) * 10)
    if now == "descent":
        return ctx.text(Text.hint_descent)
    island = objective(ctx)
    if island is not None:
        far = (depot(ctx, island).transform.position - plane.transform.position).flat().length()
        return ctx.text(Text.hint_ahead, island=ctx.text(island.data.name), distance=distance_text(far))
    return ctx.text(Text.hint_cruise)


QUIET = {
    "ias": 0, "ias_amber": False, "ias_red": False, "alt": 0, "vs": "", "vs_short": "", "vs_red": False,
    "vs_green": False, "thr_rev": False, "thr_fill": "0px", "thr_grip": "calc(var(--u) * 14)", "thr_width": "0%", "thr_text": "",
    "aoa": "", "aoa_amber": False, "aoa_red": False, "att": "none", "att_small": "none", "phase": "",
    "phase_red": False, "phase_hint": "",
}


def instruments(ctx: Context, plane: Entity | None, prompt: str) -> dict:
    """The instrument strip; QUIET on foot (the strip is hidden then)."""
    if plane is None:
        return QUIET
    vehicle = plane.get(Vehicle)
    throttle = plane.get(Cockpit).throttle
    climb = plane.get(Rigidbody).velocity.y
    warning, stalled = stall_state(ctx, plane)
    aoa = angle_of_attack(plane)
    level = clamp(round(max(0.0, throttle) * 100), 0, 100)
    reversing = throttle < -0.02
    fill = round(level / 100 * 86)
    roll = -plane.transform.euler.z
    pitch = clamp(-plane.transform.euler.x, -25, 25)
    sink = f"{abs(climb):.1f}"
    now = phase(ctx, plane, climb)
    return {
        "ias": round(abs(vehicle.speed) * 3.6),
        "ias_amber": warning and not stalled,
        "ias_red": stalled,
        "alt": max(0, round(plane.transform.position.y - ctx.config(FreightRules).water_level)),
        "vs": f"▲ {sink} m/s" if climb > 0.05 else (f"▼ {sink} m/s" if climb < -0.05 else "— 0.0 m/s"),
        "vs_short": f"▲{sink}" if climb > 0.05 else (f"▼{sink}" if climb < -0.05 else "—0.0"),
        "vs_red": climb < -5,
        "vs_green": climb > 0.05,
        "thr_rev": reversing,
        "thr_fill": u(fill),
        "thr_grip": u(-4 if reversing else 18 + fill - 4),
        "thr_width": "100%" if reversing else f"{level}%",
        "thr_text": ctx.text(Text.reverse) if reversing else f"{level}%",
        "aoa": f"{round(aoa * 10) / 10}°",
        "aoa_amber": aoa > ctx.config(FreightRules).stall_warning_aoa and not stalled,
        "aoa_red": stalled,
        "att": f"rotate({-roll:.0f}deg) translateY({u(round(pitch * 2))})",
        "att_small": f"rotate({-roll:.0f}deg) translateY({u(round(pitch * 0.9))})",
        "phase": ctx.text(PHASES[now]),
        "phase_red": stalled,
        "phase_hint": phase_hint(ctx, plane, now, prompt),
    }


def flight_hud(ctx: Context) -> dict:
    seat = flown(ctx)
    kind = prompt_kind(ctx, seat)
    return {
        **career_strip(ctx),
        **objective_line(ctx),
        **deadline(ctx),
        **alert(ctx, seat),
        **prompts(ctx, seat, kind),
        **instruments(ctx, seat, kind),
        "toasts": toasts(ctx),
        "flying": seat is not None,
    }
