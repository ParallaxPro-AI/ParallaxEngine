"""Barks (library piece `barks`).

Lines are content — `content/bark/<id>.json`: a `voice` ("guard", "villager"), a `trigger`
and the lines to pick from. A speaker is any entity with a `Barker` component naming its
voice. Barks happen on:

    BarkRequested(speaker, trigger)   anything: AI spotting the player ("spotted"), a quest
    HurtBarks                         combat Damaged on a Barker → "hurt" (needs combat())
    near                              an entity tagged `near_tag` comes within `near_radius`
    idle                              each speaker, every `idle_every` seconds ± half

`Barks` picks a line on the seeded `random` (never the speaker's previous line when there
is another), honours the speaker's own `cooldown` and the config's global one, shows it
with `ctx.ui.label` over the speaker for `seconds`, and emits `BarkSaid` (subtitles,
voice playback, tests). The speaker's timing and last line live on its component, so they
save with it."""

import random

from parallax import (
    Entity, Localized, System, Tag, component, config, content, event, field, on, resource, system, vec3,
)


@content("bark")
class BarkDef:
    voice: str
    trigger: str = field(doc='"spotted", "hurt", "near", "idle", or any trigger your game requests.')
    lines: list[Localized] = field([])


@component("barker")
class Barker:
    voice: str
    cooldown: float = field(6, min=0, unit="s")
    next_at: float = field(0, doc="Game time it may speak again (kept by Barks).")
    idle_at: float = field(0, doc="Game time of its next idle line (kept by Barks).")
    last_line: str = field("")
    near: bool = field(False, doc="Something tagged near_tag is close (kept by Barks).")


@config("barks")
class BarksConfig:
    """config/barks.json."""
    global_cooldown: float = field(1.5, min=0, unit="s", doc="Between any two barks.")
    seconds: float = field(2.5, min=0.5, unit="s", doc="How long a line stays up.")
    idle_every: float = field(0, min=0, unit="s", doc="0: no idle lines.")
    near_tag: Tag | None = field(None)
    near_radius: float = field(4, min=0, unit="m")
    height: float = field(2.2, unit="m", doc="Label height over the speaker.")


@resource("bark_clock", keep="scene")
class BarkClock:
    next_at: float = field(0)


@event("bark_requested")
class BarkRequested:
    speaker: Entity
    trigger: str


@event("bark_said", target="speaker")
class BarkSaid:
    speaker: Entity
    trigger: str
    text: str


def say(ctx, speaker: Entity, trigger: str) -> bool:
    """Bark now if the cooldowns allow and the voice has lines for the trigger."""
    barker = speaker.try_get(Barker)
    clock = ctx.get(BarkClock)
    if barker is None or ctx.time.now < barker.next_at or ctx.time.now < clock.next_at:
        return False
    lines = []
    for entry in ctx.content(BarkDef).where(lambda b: b.voice == barker.voice and b.trigger == trigger):
        lines.extend(ctx.text(line) for line in entry.data.lines)
    if not lines:
        return False
    fresh = [line for line in lines if line != barker.last_line] or lines
    text = random.choice(fresh)
    rules = ctx.config(BarksConfig)
    barker.last_line = text
    barker.next_at = ctx.time.now + barker.cooldown
    clock.next_at = ctx.time.now + rules.global_cooldown
    label = ctx.ui.label(speaker, text, offset=vec3(0, rules.height, 0))
    ctx.time.after(rules.seconds, label.cancel)
    ctx.emit(BarkSaid(speaker=speaker, trigger=trigger, text=text))
    return True


@system("barks")
class Barks(System):
    """Requested, proximity and idle barks."""

    @on(BarkRequested)
    def requested(self, ctx, e: BarkRequested):
        if e.speaker.alive:
            say(ctx, e.speaker, e.trigger)

    def update(self, ctx, dt):
        rules = ctx.config(BarksConfig)
        for speaker, barker in ctx.world.query(Barker):
            if rules.near_tag is not None:
                close = ctx.world.query(tagged=rules.near_tag).near(speaker.transform.position, rules.near_radius).count() > 0
                if close and not barker.near:
                    say(ctx, speaker, "near")
                barker.near = close
            if rules.idle_every > 0:
                if barker.idle_at == 0:
                    barker.idle_at = ctx.time.now + random.uniform(0.5, 1.5) * rules.idle_every
                elif ctx.time.now >= barker.idle_at:
                    barker.idle_at = ctx.time.now + random.uniform(0.5, 1.5) * rules.idle_every
                    say(ctx, speaker, "idle")
