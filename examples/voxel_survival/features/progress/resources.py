from parallax import ContentRef, Context, TextRef, field, resource
from project import Text

from game.content import ObjectiveDef


@resource("progress")
class Progress:
    done: list[ContentRef[ObjectiveDef]] = field([])


@resource("lifetime", keep="profile")
class Lifetime:
    """Across every world this player has made."""
    blocks_mined: int = field(0)


def next_objective(ctx: Context) -> TextRef:
    """The first objective (in `order`) not yet done."""
    done = ctx.get(Progress).done
    return next((o.data.text for o in ctx.content(ObjectiveDef) if o not in done), Text.objective_free_play)
