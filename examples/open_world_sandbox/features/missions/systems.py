"""The job in progress: what its steps set off, its pay, its clock, and failing it."""

from parallax import System, on, system
from parallax.combat import Died
from parallax.story import QuestCompleted, QuestStepCompleted
from project import Text

from features.missions.content import JobKind
from features.missions.contracts import contract_of, end_job, fail_job, rushing, step_verb
from features.missions.facts import CargoRushed, ContractsCompleted
from features.missions.resources import Job
from features.on_foot.feature import Player, Wallet
from features.police.feature import CrimeCommitted, PlayerBusted


@system("jobs")
class Jobs(System):
    """Reacts to a contract's quest: the pickup reports its crime and starts a getaway's clock, completion
    pays out, and WASTED or BUSTED puts the job back on the board. The steps themselves are custom verbs
    (verbs.py)."""

    @on(QuestStepCompleted, where=lambda event: step_verb(event) == "pick_up")
    def picked_up(self, ctx, event: QuestStepCompleted):
        contract = contract_of(ctx, event.quest)
        rushed = rushing(ctx, contract)
        ctx.story.facts.set(CargoRushed, rushed)
        if contract.pickup_crime is not None and (rushed or contract.kind is not JobKind.COURIER):
            at = ctx.world.query(tagged=Player).single().transform.position
            ctx.emit(CrimeCommitted(crime=contract.pickup_crime, at=at))
        if contract.seconds:
            ctx.get(Job).clock.restart(contract.seconds)

    @on(QuestCompleted)
    def paid(self, ctx, event: QuestCompleted):
        contract = contract_of(ctx, event.quest)
        quiet = contract.kind is JobKind.COURIER and not ctx.story.facts.get(CargoRushed)
        ctx.get(Wallet).cash += contract.reward + (contract.quiet_bonus if quiet else 0)
        ctx.story.facts.add(ContractsCompleted)
        end_job(ctx, Text.job_paid)
        ctx.story.say(contract.contact.data.dialogue, node=contract.paid_node)
        ctx.save.save("auto")

    @on(Died, where=lambda event: event.entity.has(Player))
    def wasted(self, ctx, event: Died):
        fail_job(ctx, Text.job_failed_wasted)

    @on(PlayerBusted)
    def busted(self, ctx, event: PlayerBusted):
        fail_job(ctx, Text.job_failed_busted)


@system("getaway_clock", when=lambda ctx: not ctx.get(Job).clock.done)
class GetawayClock(System):
    """Runs a getaway's window from the pickup; when it closes, the job goes back on the board."""

    def update(self, ctx, dt):
        if ctx.get(Job).clock.tick(dt):
            fail_job(ctx, Text.job_failed_clock)
