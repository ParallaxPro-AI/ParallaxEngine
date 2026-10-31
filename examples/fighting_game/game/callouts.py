"""The HUD's centre call-out: one line at a time, replaced by the next."""

from parallax import Context

from game.resources import Callout, CalloutStyle
from game.rules import Rules


def call_out(ctx: Context, text: str, style: CalloutStyle = CalloutStyle.GOLD) -> None:
    """Show `text` in the HUD's call-out slot."""
    callout = ctx.get(Callout)
    callout.text = text
    callout.style = style
    callout.until = ctx.time.now + ctx.config(Rules).callout_seconds
