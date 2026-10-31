import random

from parallax import System, on, system, vec2
from parallax.combat import Died
from project import Assets, Text

from game.audio import Sounds, play
from game.build import current_wave, find_wisp
from game.components import Guardian
from game.events import (
    BloomCollected, BombBloomed, BombsEmpty, RunEnded, ShieldBroken, SpiritBloomed,
    UpgradePicked, WaveCleared, WaveStarted, WispHurt,
)
from game.resources import Banner


@system("feedback")
class Feedback(System):
    """Banners, sounds, bursts and screen shake. The garden's music is declared by its
    scene; the cues and their volumes are config/audio.json."""

    def update(self, ctx, dt):
        if ctx.get(Banner).timer.tick(dt):
            ctx.reset(Banner)

    @on(WaveStarted)
    def wave_started(self, ctx, event: WaveStarted):
        name = current_wave(ctx).data.name
        if event.boss:
            banner(ctx, "warn", ctx.text(name), kick=ctx.text(Text.warning_kick), seconds=2)
            play(ctx, ctx.config(Sounds).boss_warning)
        else:
            banner(ctx, "wave", ctx.text(name), seconds=2,
                   kick=ctx.text(Text.wave_kick, number=event.index + 1))
            play(ctx, ctx.config(Sounds).wave_begin)

    @on(Died, where=lambda event: event.entity.has(Guardian))
    def guardian_banished(self, ctx, event: Died):
        boss = event.entity.get(Guardian).kind.data.boss
        at = event.entity.transform.position.xy()
        ctx.vfx.play(Assets.vfx.petal_burst, at=at)
        if boss:  # the Thornmother comes apart in five more blossoms around her
            for _ in range(5):
                ctx.vfx.play(Assets.vfx.petal_burst, at=at + vec2(random.uniform(-1.4, 1.4), random.uniform(-1.4, 1.4)))
        play(ctx, ctx.config(Sounds).boss_banished if boss else ctx.config(Sounds).guardian_banished)
        ctx.camera.main.shake(0.5 if boss else 0.12, 0.42 if boss else 0.15)

    @on(WispHurt)
    def hurt(self, ctx, event: WispHurt):
        ctx.vfx.play(Assets.vfx.petal_burst, at=find_wisp(ctx))
        play(ctx, ctx.config(Sounds).petal_lost)
        ctx.camera.main.shake(0.42, 0.36)

    @on(ShieldBroken)
    def shield_broken(self, ctx, event: ShieldBroken):
        play(ctx, ctx.config(Sounds).shield_break)
        ctx.camera.main.shake(0.2, 0.18)

    @on(BombBloomed)
    def bomb(self, ctx, event: BombBloomed):
        banner(ctx, "bloom", ctx.text(Text.petal_bloom), seconds=1)
        play(ctx, ctx.config(Sounds).bomb)
        ctx.camera.main.shake(0.55, 0.4)

    @on(BombsEmpty)
    def bombs_empty(self, ctx, event: BombsEmpty):
        banner(ctx, "empty", ctx.text(Text.no_blooms), seconds=1.2)

    @on(SpiritBloomed)
    def spirit_bloomed(self, ctx, event: SpiritBloomed):
        banner(ctx, "spirit", ctx.text(Text.spirit_bloom), seconds=1)

    @on(BloomCollected)
    def bloom_collected(self, ctx, event: BloomCollected):
        banner(ctx, "pickup", ctx.text(event.bloom.data.label), seconds=1.2)
        play(ctx, ctx.config(Sounds).bloom_collected)

    @on(WaveCleared, where=lambda event: not event.final)
    def wave_cleared(self, ctx, event: WaveCleared):
        play(ctx, ctx.config(Sounds).shrine_open)

    @on(UpgradePicked)
    def attuned(self, ctx, event: UpgradePicked):
        play(ctx, ctx.config(Sounds).shrine_pick)

    @on(RunEnded)
    def run_ended(self, ctx, event: RunEnded):
        if event.won:
            play(ctx, ctx.config(Sounds).victory)


def banner(ctx, kind: str, title: str, *, seconds: float, kick: str = "") -> None:
    """Raise the centre banner (the HUD draws it, as the template's HUD did)."""
    shown = ctx.get(Banner)
    shown.kind = kind
    shown.kick = kick
    shown.title = title
    shown.timer.restart(seconds)
