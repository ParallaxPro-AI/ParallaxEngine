"""Looking contracts up, reading how a pickup was made, and ending the job in progress."""

from typing import Literal

from parallax import Context, ContentRef, TextRef
from parallax.story import QuestDef, QuestStepCompleted

from features.missions.actions import JobControls
from features.missions.content import Contract, JobKind
from features.missions.resources import Job

Status = Literal["available", "locked", "active", "done"]


def contract_of(ctx: Context, quest: ContentRef[QuestDef]) -> Contract:
    """A contract's own fields. Quest events and verbs hand over the plugin's `ContentRef[QuestDef]`."""
    return ctx.content(Contract).get(quest.id).data


def active_contract(ctx: Context) -> ContentRef[Contract] | None:
    """The contract in progress. Every quest in Sunset Bay is a contract, and at most one runs at a time."""
    active = ctx.story.quests("active")
    return ctx.content(Contract).get(active[0].id) if active else None


def status(ctx: Context, contract: ContentRef[Contract]) -> Status:
    """How the board shows a contract. A failed run goes back to available."""
    state = ctx.story.quest(contract).status
    if state == "active":
        return "active"
    if state == "completed":
        return "done"
    needed = contract.data.requires
    if needed is not None and ctx.story.quest(needed).status != "completed":
        return "locked"
    return "available"


def step_verb(event: QuestStepCompleted) -> str:
    """The verb of the step that just completed: handlers react to *kinds* of step, not step ids."""
    return event.quest.data.steps[event.step].verb


def rushing(ctx: Context, contract: Contract) -> bool:
    """A courier grabbing the cargo with the fast-pickup key this frame."""
    return contract.kind is JobKind.COURIER and ctx.input.pressed(JobControls.fast_pickup)


def fail_job(ctx: Context, notice: TextRef) -> None:
    """Put the running job back on the board, unpaid, with a message saying why."""
    contract = active_contract(ctx)
    if contract is None:
        return
    ctx.story.fail_quest(contract)
    end_job(ctx, notice)


def end_job(ctx: Context, notice: TextRef) -> None:
    ctx.reset(Job)
    ctx.get(Job).notice = notice
    ctx.ui.toast(notice, seconds=4)
