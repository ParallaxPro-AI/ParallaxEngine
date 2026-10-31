"""Contracts and services."""

from enum import Enum

from parallax import ContentRef, EntityRef, Localized, content, field
from parallax.story import QuestDef

from features.phone.feature import ContactDef
from features.police.feature import CrimeDef


class JobKind(Enum):
    """What a contract asks for.

    courier   collect cargo (a quiet handover for a bonus, or a fast pickup that draws heat), deliver it
    recovery  take the marked `vehicle`, shake the police, deliver that exact car
    getaway   collect a runner and get them to the drop within `seconds` of the pickup
    """

    COURIER = "courier"
    RECOVERY = "recovery"
    GETAWAY = "getaway"


class ServiceKind(Enum):
    ARMOUR = "armour"
    REPAIR = "repair"
    PERMIT = "permit"
    SAVE = "save"


@content("quest")
class Contract(QuestDef):
    """One job (content/quest/<id>.json): a story-plugin quest whose steps use this feature's verbs, plus who
    offers it, what it pays, and the rules those verbs and the job's handlers read."""

    contact: ContentRef[ContactDef] = field(doc="Their .yarn file plays the briefing and the payoff.")
    kind: JobKind = field(JobKind.COURIER)
    brief_node: str = field(doc="Played when the job is accepted.")
    paid_node: str = field(doc="Played when the job pays out.")
    vehicle: EntityRef | None = field(None, doc="The one car that counts, if any.")
    pickup_crime: ContentRef[CrimeDef] | None = field(None, doc="Reported at the pickup (a courier's only when rushed).")
    requires: ContentRef["Contract"] | None = field(None, doc="Unlocked once this contract is done.")
    reward: int = field(0, min=0)
    quiet_bonus: int = field(0, min=0)
    seconds: float = field(0, min=0, unit="s", doc="Getaway clock, from pickup to delivery.")


@content("service")
class ServiceDef:
    """Something bought at a place: armour at the supply store, repairs and the permit at the garage."""

    name: Localized = field()
    kind: ServiceKind = field(ServiceKind.ARMOUR)
    price: int = field(0, min=0)
    at: EntityRef = field(doc="The interior zone you must be standing in.")
