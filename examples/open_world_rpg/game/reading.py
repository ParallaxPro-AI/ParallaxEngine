"""The journal's text-size switch (Normal / Large), as in the template: large text scales the HUD's
cards by 1.18 and the journal by 1.12. Kept with the profile, like the template's uiScale."""

from parallax import Context, field, resource


@resource("reading", keep="profile")
class Reading:
    large: bool = field(False)


def text_normal(ctx: Context) -> None:
    ctx.get(Reading).large = False


def text_large(ctx: Context) -> None:
    ctx.get(Reading).large = True
