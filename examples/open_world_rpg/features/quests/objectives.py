"""What the tracker and the journal say to do next."""

from parallax import Context, ContentRef
from parallax.story import QuestDef


def objective_line(ctx: Context, quest: ContentRef[QuestDef]) -> str:
    """The active step's objective text; empty unless the quest is active."""
    progress = ctx.story.quest(quest)
    if progress.status != "active" or not progress.active_steps:
        return ""
    return ctx.text(quest.data.steps[progress.active_steps[0]].text)
