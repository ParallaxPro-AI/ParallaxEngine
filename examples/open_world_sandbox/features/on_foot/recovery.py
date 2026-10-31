"""Starting a WASTED or BUSTED stinger."""

from parallax import Context, EntityRef

from features.on_foot.resources import Recovery, Setback


def begin_recovery(ctx: Context, kind: Setback, release: EntityRef, seconds: float) -> None:
    recovery = ctx.get(Recovery)
    recovery.kind = kind
    recovery.release = release
    recovery.countdown.restart(seconds)
