"""The voyage: one purse, one clock and one crew pool shared by every captain.
Every field is replicated so each client's HUD reads the server's truth."""

from enum import Enum

from parallax import ContentRef, field, resource

from game.content import ContractDef, UpgradeDef


class Phase(Enum):
    REFIT = "refit"
    SAILING = "sailing"
    ENDED = "ended"


@resource("voyage")
class Voyage:
    phase: Phase = field(Phase.REFIT, replicate=True)
    leg: int = field(0, replicate=True, doc="Index into the voyage's legs.")
    time_left: float = field(0, unit="s", replicate=True)
    leg_gold: int = field(0, replicate=True)
    purse: int = field(0, replicate=True)
    bounty: int = field(0, replicate=True)
    sinkings: int = field(0, replicate=True, doc="Crew spent this voyage.")
    offers: list[ContentRef[UpgradeDef]] = field([], replicate=True)
    levels: dict[str, int] = field({}, replicate=True, doc="Upgrade id -> times taken.")
    plunder: dict[str, int] = field({}, replicate=True, doc="Player id -> gold brought aboard.")
    won: bool = field(False, replicate=True)
    standing: dict[str, float] = field({}, replicate=True, doc="Faction id -> standing this voyage (unset: its start).")
    contract: ContentRef[ContractDef] | None = field(None, replicate=True, doc="The open contract, if any.")
    contract_progress: int = field(0, replicate=True)
    contracts_taken: int = field(0, replicate=True, doc="Taken in order, repeating.")
    contracts_paid: int = field(0, replicate=True)


@resource("harbour", keep="session")
class Harbour:
    """This captain's own menu state: the title card is up until they set sail.
    Per client, never replicated; it survives Sail again within the session."""
    at_title: bool = field(True)


@resource("ledger", keep="profile")
class Ledger:
    """The captain's career across voyages (the template's title ledger)."""
    gold: int = field(0, doc="Gold brought home over every voyage.")
    voyages_won: int = field(0)
    best_leg: int = field(0, doc="Furthest leg reached, 1-based (0: never sailed).")
