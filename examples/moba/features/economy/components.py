from parallax import ContentRef, Localized, component, field

from game.content import ItemDef, StatBlock


@component("wallet")
class Wallet:
    """Only the owner sees their gold."""
    gold: int = field(0, min=0, replicate="owner")


@component("items")
class Items:
    """What a champion has bought, up to `MatchRules.item_slots`. Teammates see it."""
    owned: list[ContentRef[ItemDef]] = field([], replicate="team")


@component("bounty")
class Bounty:
    """What killing this unit pays the champion who lands the last hit."""
    gold: int = field(0, min=0)
    xp: float = field(0, min=0)
    reward: StatBlock = field(StatBlock(), doc="Permanent stats for the killer (jungle buffs).")
    announcement: Localized | None = field(None, doc="Announced (with {champion}) when the reward is taken.")
