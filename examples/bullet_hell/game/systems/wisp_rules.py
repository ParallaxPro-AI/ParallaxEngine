from parallax import System, on, system
from parallax.combat import Damaged, Health
from project import Scenes

from game.build import attune, find_wisp, stacks
from game.components import Wisp
from game.config import Build
from game.content import BloomEffect, Gun
from game.events import (
    BloomCollected, BombBloomed, BombRequested, BombsEmpty, GuardianEscaped, Grazed,
    ShieldBroken, SpiritBloomed, UpgradePicked, WaveStarted, WispHurt,
)


@system("wisp_rules", scenes=[Scenes.garden])
class WispRules(System):
    """Everything that changes the Wisp's state. Its petals and dewshields are its
    `Health` (`current` and `shield`); every hit grants i-frames; grazing fills
    Spirit, which turns into bombs; blooms swap the gun or bank shields and bombs;
    each attunement taken becomes a stat modifier on the Wisp, and some also give a
    gift the moment they're taken; Dewward tops up shields every wave."""

    def update(self, ctx, dt):
        for _, wisp in ctx.world.query(Wisp):
            if wisp.gun_time.tick(dt):
                wisp.gun = Gun.SINGLE

    @on(Damaged, where=lambda event: event.entity.has(Wisp))
    def hit(self, ctx, event: Damaged):
        wisp = event.entity.get(Wisp)
        event.entity.get(Health).protect(wisp.invulnerability)
        if event.amount == 0:  # a dewshield took the whole hit
            ctx.emit(ShieldBroken())
            return
        wisp.gun = Gun.SINGLE
        wisp.gun_time.restart(0)
        ctx.emit(WispHurt())

    @on(GuardianEscaped)
    def escaped(self, ctx, event: GuardianEscaped):
        find_wisp(ctx).get(Health).damage(1)

    @on(Grazed)
    def grazed(self, ctx, event: Grazed):
        wisp = event.wisp.get(Wisp)
        spirit_max = ctx.config(Build).spirit_max
        wisp.spirit += wisp.graze_gain
        while wisp.spirit >= spirit_max:
            wisp.spirit -= spirit_max
            if wisp.bombs < wisp.max_bombs:
                wisp.bombs += 1
                ctx.emit(SpiritBloomed())

    @on(BombRequested)
    def bomb(self, ctx, event: BombRequested):
        wisp = event.wisp.get(Wisp)
        if wisp.bombs == 0:
            ctx.emit(BombsEmpty())
            return
        wisp.bombs -= 1
        event.wisp.get(Health).protect(ctx.config(Build).bomb_invulnerability)
        ctx.emit(BombBloomed())

    @on(BloomCollected)
    def bloom(self, ctx, event: BloomCollected):
        bloom = event.bloom.data
        if bloom.effect is BloomEffect.GUN:
            wisp = event.wisp.get(Wisp)
            wisp.gun = bloom.gun
            wisp.gun_time.restart(bloom.duration)
        elif bloom.effect is BloomEffect.SHIELD:
            self.give(ctx, event.wisp, shields=1)
        else:
            self.give(ctx, event.wisp, bombs=bloom.amount)

    @on(WaveStarted)
    def wave_started(self, ctx, event: WaveStarted):
        wisp = find_wisp(ctx)
        self.give(ctx, wisp, shields=int(wisp.get(Wisp).wave_shields))

    @on(UpgradePicked)
    def attuned(self, ctx, event: UpgradePicked):
        wisp = find_wisp(ctx)
        health = wisp.get(Health)
        petals = health.current
        attune(wisp, event.upgrade, stacks(ctx, event.upgrade))
        upgrade = event.upgrade.data
        self.give(ctx, wisp, shields=upgrade.grant_shields, bombs=upgrade.grant_bombs)
        # Raising Health.max keeps the fraction, but petals are whole: count them instead.
        health.current = min(petals + upgrade.heal, health.max)

    def give(self, ctx, wisp, *, lives: int = 0, shields: int = 0, bombs: int = 0):
        """Add petals, shields and bombs, each capped by the build."""
        health = wisp.get(Health)
        health.heal(lives)
        health.shield = min(ctx.config(Build).shield_cap, health.shield + shields)
        arsenal = wisp.get(Wisp)
        arsenal.bombs = min(int(arsenal.max_bombs), arsenal.bombs + bombs)
