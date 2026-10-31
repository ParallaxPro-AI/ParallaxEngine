"""The journal."""

from parallax import Panel, close_panel, ui

from features.quests.actions import QuestControls
from features.quests.content import Chapter
from features.quests.objectives import objective_line
from game.reading import Reading, text_large, text_normal


@ui("journal", html="ui/journal.html", modal=True, layer="menu", toggle_with=QuestControls.journal)
class JournalPanel(Panel):
    """The six chapters in story order (done, current with its objective, or still ahead), what to do now,
    the controls, and the text-size switch."""

    actions = {"close": close_panel(), "text_normal": text_normal, "text_large": text_large}

    def state(self, ctx):
        rows, now = [], ""
        for number, chapter in enumerate(ctx.content(Chapter), start=1):
            status = ctx.story.quest(chapter).status
            objective = objective_line(ctx, chapter)
            if status == "active":
                now = objective
            rows.append({
                "number": f"{number:02d}",
                "title": ctx.text(chapter.data.title),
                "objective": objective,
                "done": status == "completed", "cur": status == "active", "up": status == "inactive",
            })
        large = ctx.get(Reading).large
        return {"chapters": rows, "now": now, "large": large, "normal_text": not large}
