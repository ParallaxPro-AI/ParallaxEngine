"""The HUD's two lines of text, as the template drew them: the message pill above the seed
tray (the garden's hint, a seed's blurb, "need 100 pollen") and the ribbon under the top
bar (a wave arriving in gold, a husk at the house in red)."""

from parallax import Context, field, resource

MESSAGE_SECONDS = 5
HINT_SECONDS = 8
WAVE_SECONDS = 2.2
DANGER_SECONDS = 3


@resource("garden_notes")
class GardenNotes:
    message: str = field("")
    message_until: float = field(0, unit="s")
    notice: str = field("")
    danger: bool = field(False)
    notice_until: float = field(0, unit="s")


def say(ctx: Context, text: str, seconds: float = MESSAGE_SECONDS) -> None:
    """Show `text` in the message pill (formatted text, `ctx.text(...)`)."""
    notes = ctx.get(GardenNotes)
    notes.message, notes.message_until = text, ctx.time.now + seconds


def announce(ctx: Context, text: str, *, danger: bool = False) -> None:
    """Drop the ribbon: gold for a wave, red (and a shake) for danger."""
    notes = ctx.get(GardenNotes)
    notes.notice, notes.danger = text, danger
    notes.notice_until = ctx.time.now + (DANGER_SECONDS if danger else WAVE_SECONDS)
