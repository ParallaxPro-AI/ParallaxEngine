"""The contracts board: the panel, and the buttons that start and abandon jobs."""

from parallax import Context, ContentRef, Panel, close_panel, ui
from project import Text

from features.missions.actions import BoardControls
from features.missions.content import Contract, ServiceDef, ServiceKind
from features.missions.contracts import active_contract, fail_job, status
from features.missions.facts import ContractsCompleted, PermitOwned
from features.missions.resources import Job
from features.missions.services import buy_service
from features.on_foot.feature import Wallet
from features.phone.feature import Waypoint


def accept(ctx: Context, contract: ContentRef[Contract]) -> None:
    """Start a job if it is unlocked and nothing else is running: the board closes, the contact briefs
    you, and the quest's own markers take over the GPS."""
    if active_contract(ctx) is not None:
        return
    if status(ctx, contract) == "locked":
        ctx.get(Job).notice = Text.job_locked
        return
    ctx.reset(Job)
    ctx.reset(Waypoint)
    ctx.story.start_quest(contract)
    ctx.ui.close(ContractsPanel)
    ctx.story.say(contract.data.contact.data.dialogue, node=contract.data.brief_node)


def abandon(ctx: Context) -> None:
    fail_job(ctx, Text.job_abandoned)


@ui("contracts", html="ui/contracts.html", modal=True, layer="menu", toggle_with=BoardControls.contracts)
class ContractsPanel(Panel):
    """Every contract (done, available, locked, or running) and the services money can buy."""

    actions = {"accept": accept, "abandon": abandon, "service": buy_service, "close": close_panel()}

    def state(self, ctx):
        notice = ctx.get(Job).notice
        running = active_contract(ctx) is not None
        contracts = [self.contract_row(ctx, i, c, running) for i, c in enumerate(ctx.content(Contract))]
        services = list(ctx.content(ServiceDef))
        owned = bool(ctx.story.facts.get(PermitOwned))
        runs = ctx.story.facts.get(ContractsCompleted)
        return {
            "cash": ctx.get(Wallet).cash,
            "notice": ctx.text(notice) if notice is not None else ctx.text(Text.board_notice),
            "running": running,
            "idle": not running,
            "contracts": contracts,
            "services": [
                {
                    "service": s.id,
                    "name": ctx.text(s.data.name),
                    "price": s.data.price,
                    "owned": s.data.kind is ServiceKind.PERMIT and owned,
                }
                for s in services if s.data.kind is not ServiceKind.SAVE
            ],
            "progress": ctx.text(Text.board_progress_one if runs == 1 else Text.board_progress, runs=runs,
                                 done=sum(1 for row in contracts if row["status"] == "done"), total=len(contracts)),
        }

    def contract_row(self, ctx: Context, index: int, contract: ContentRef[Contract], running: bool) -> dict[str, object]:
        data = contract.data
        shown = status(ctx, contract)
        needs = ctx.text(data.requires.data.title) if data.requires is not None else ""
        return {
            "contract": contract.id,
            "number": f"0{index + 1}",
            "title": ctx.text(data.title),
            "contact": ctx.text(data.contact.data.name),
            "reward": data.reward,
            "brief": ctx.text(data.summary),
            "status": shown,
            "accept": shown == "available",
            "progress": shown == "active",
            "locked": shown == "locked",
            "done": shown == "done",
            "locked_label": ctx.text(Text.board_locked, contract=needs),
            "unavailable": shown != "available" or running,
        }
