"""What the HUD says to do next: the contract ticket and the objective banner."""

import math

from parallax import Context, EntityRef
from project import Text

from features.missions.content import JobKind
from features.missions.contracts import active_contract
from features.missions.resources import Job
from features.on_foot.feature import Player
from features.phone.feature import PlaceDef


def objective(ctx: Context) -> dict[str, object]:
    """The running job's ticket (contact, pay, title, brief, a getaway's clock, which job keys apply) and
    its active step's text (filled with the step's place, the distance to it and the loading time so far)
    for the banner — or, between jobs, the board's last message."""
    job = ctx.get(Job)
    contract = active_contract(ctx)
    if contract is None:
        notice = ctx.text(job.notice or Text.board_notice)
        return {
            "active": False, "contact": "", "reward": 0, "title": ctx.text(Text.no_contract), "brief": notice,
            "step": ctx.text(Text.board_title), "sub": ctx.text(Text.board_hint),
            "timed": False, "clock": 0, "clock_left": "100%", "keys": False, "risk": False, "deliver": False,
        }
    data = contract.data
    step = data.steps[ctx.story.quest(contract).active_steps[0]]
    args: dict[str, object] = {"loaded": math.floor(job.loaded_for)}
    if step.target:
        place = ctx.content(PlaceDef).get(step.target).data
        args.update(place=ctx.text(place.label), distance=distance_to(ctx, place.at))
    timed = not job.clock.done
    left = job.clock.remaining / data.seconds if timed and data.seconds > 0 else 1.0
    return {
        "active": True,
        "contact": ctx.text(data.contact.data.name),
        "reward": data.reward,
        "title": ctx.text(data.title),
        "brief": ctx.text(data.summary),
        "step": ctx.text(step.text, **args),
        "sub": "",
        "timed": timed,
        "clock": math.ceil(job.clock.remaining),
        "clock_left": f"{max(0.0, min(1.0, left)) * 100:.1f}%",
        "keys": step.verb in ("pick_up", "deliver"),
        "risk": step.verb == "pick_up" and data.kind is JobKind.COURIER,
        "deliver": step.verb == "deliver",
    }


def distance_to(ctx: Context, at: EntityRef) -> int:
    here = ctx.world.query(tagged=Player).single().transform.position
    return round(here.distance_to(ctx.world.placement(at).position))
