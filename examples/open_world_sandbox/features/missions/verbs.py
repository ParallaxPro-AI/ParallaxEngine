"""Custom quest verbs: the objectives a contract's steps use that the built-in verbs can't express.

Each runs every frame while a step using it is active and returns True when the step is done. A step's
`target` is a place (content/place). Verbs only *judge* the step; what a completed step sets off — the
pickup's crime, the getaway clock, the pay — happens in `Jobs` (systems.py). Progress the HUD shows lives
in the `Job` resource.
"""

from parallax import ContentRef, Context
from parallax.story import QuestDef, QuestStep, quest_verb
from parallax.vehicles import Vehicle
from project import Text

from features.driving.feature import player_car
from features.missions.actions import JobControls
from features.missions.config import JobRules
from features.missions.content import Contract
from features.missions.contracts import contract_of, rushing
from features.missions.facts import CargoRushed, PermitOwned
from features.missions.resources import Job
from features.phone.feature import PlaceDef
from features.police.feature import Wanted, wanted_level


@quest_verb("in_car", target=ContentRef[PlaceDef])
def in_car(ctx: Context, quest: ContentRef[QuestDef], step: QuestStep, dt: float) -> bool:
    """Behind the wheel — of the contract's marked car, if it names one. The target only names the place
    the objective text mentions."""
    return in_the_right_car(ctx, contract_of(ctx, quest))


@quest_verb("pick_up", target=ContentRef[PlaceDef])
def pick_up(ctx: Context, quest: ContentRef[QuestDef], step: QuestStep, dt: float) -> bool:
    """Stopped in the bay: hand over, or (couriers only) grab the cargo and run."""
    if not stopped_in_bay(ctx, step.target):
        return False
    return ctx.input.pressed(JobControls.handover) or rushing(ctx, contract_of(ctx, quest))


@quest_verb("hold_still", target=ContentRef[PlaceDef])
def hold_still(ctx: Context, quest: ContentRef[QuestDef], step: QuestStep, dt: float) -> bool:
    """Keep the car still in the bay while the cargo loads: shorter with the permit, shortest when rushed."""
    job = ctx.get(Job)
    job.loaded_for = job.loaded_for + dt if stopped_in_bay(ctx, step.target) else 0.0
    rules = ctx.config(JobRules)
    if ctx.story.facts.get(CargoRushed):
        needed = rules.risky_load
    else:
        needed = rules.permit_load if ctx.story.facts.get(PermitOwned) else rules.quiet_load
    return job.loaded_for >= needed


@quest_verb("lose_heat")
def lose_heat(ctx: Context, quest: ContentRef[QuestDef], step: QuestStep, dt: float) -> bool:
    """No wanted level."""
    return wanted_level(ctx.get(Wanted)) == 0


@quest_verb("deliver", target=ContentRef[PlaceDef])
def deliver(ctx: Context, quest: ContentRef[QuestDef], step: QuestStep, dt: float) -> bool:
    """Stopped in the drop bay with no heat on you, in the right car: hand over."""
    if not stopped_in_bay(ctx, step.target) or not ctx.input.pressed(JobControls.handover):
        return False
    if wanted_level(ctx.get(Wanted)) > 0:
        return False
    if not in_the_right_car(ctx, contract_of(ctx, quest)):
        ctx.ui.toast(Text.job_wrong_car)
        return False
    return True


def in_the_right_car(ctx: Context, contract: Contract) -> bool:
    car = player_car(ctx)
    return car is not None and (contract.vehicle is None or car == ctx.world.placement(contract.vehicle).loaded)


def stopped_in_bay(ctx: Context, place: str) -> bool:
    """The player's car is (almost) stopped within the loading bay of a place."""
    car = player_car(ctx)
    rules = ctx.config(JobRules)
    if car is None or abs(car.get(Vehicle).speed) >= rules.stopped_speed:
        return False
    bay = ctx.world.placement(ctx.content(PlaceDef).get(place).data.at).position
    return car.transform.position.distance_to(bay) <= rules.bay_radius
