from parallax import MusicLayer, System, on, system
from parallax.combat import Damaged, Died, EffectApplied, Side
from project import Assets

from features.heroes.feature import Hero, LeveledUp
from features.lanes.feature import Minion
from features.soundscape.resources import MusicState, SoundCooldowns
from game.audio import MusicIntensity, Sounds, excite, play
from game.components import Core, Magic, Tower
from game.resources import Match, Phase

HIT_COOLDOWN = 0.04
"""Seconds between two hits of one cue (a wave clash is not a drum roll)."""
MINION_HIT_COOLDOWN = 0.06
MINION_DIE_COOLDOWN = 0.05
INTENSITY_DECAY = 0.22
"""Per second (the template's soundscape `intensity.decayPerSecond`)."""



@system("soundscape")
class Soundscape(System):
    """Which event makes which noise, where (the template's audio/soundscape table):
    blows by who struck them, deaths by what fell, slows, level-ups and the announcer's
    victory and defeat calls. Casts, purchases, last hits, respawns, waves and the
    announcer's other calls play where they happen in the features."""

    @on(Damaged)
    def struck(self, ctx, event: Damaged):
        sounds = ctx.config(Sounds)
        source = event.source
        if source is None:
            return
        last = ctx.get(SoundCooldowns)
        now = ctx.time.now
        if source.has(Tower):
            if now - last.tower_fire >= HIT_COOLDOWN:
                last.tower_fire = now
                excite(ctx, 0.05)
                play(ctx, sounds.tower_fire, event.entity)
        elif source.has(Minion):
            if now - last.minion_hit >= MINION_HIT_COOLDOWN:
                last.minion_hit = now
                excite(ctx, 0.05)
                play(ctx, sounds.minion_hit, event.entity)
        elif source.has(Hero) and event.kind == Magic:
            if now - last.hit_champion >= HIT_COOLDOWN:
                last.hit_champion = now
                excite(ctx, 0.05)
                play(ctx, sounds.hit_champion, event.entity)
        elif now - last.attack_melee >= HIT_COOLDOWN:
            last.attack_melee = now
            excite(ctx, 0.05)
            play(ctx, sounds.attack_melee, event.entity)

    @on(Died)
    def fell(self, ctx, event: Died):
        sounds = ctx.config(Sounds)
        victim = event.entity
        excite(ctx, 0.3 if victim.has(Hero) or victim.has(Tower) else 1.0 if victim.has(Core) else 0.02)
        if victim.has(Hero):
            play(ctx, sounds.champ_death, victim)
            if event.source is not None and event.source.has(Hero):
                play(ctx, sounds.vo_kill)
        elif victim.has(Core):
            play(ctx, sounds.structure_fall, victim)
            loser = victim.get(Side).side
            for player in ctx.players:
                won = player.entity.get(Side).side != loser
                play(ctx, sounds.vo_victory if won else sounds.vo_defeat, to=player)
        elif victim.has(Tower):
            play(ctx, sounds.structure_fall, victim)
            play(ctx, sounds.vo_structure)
        elif ctx.time.now - ctx.get(SoundCooldowns).minion_die >= MINION_DIE_COOLDOWN:
            ctx.get(SoundCooldowns).minion_die = ctx.time.now
            play(ctx, sounds.minion_die, victim)

    @on(EffectApplied)
    def slowed(self, ctx, event: EffectApplied):
        play(ctx, ctx.config(Sounds).cc_slow, event.entity)
        excite(ctx, 0.08)

    @on(LeveledUp)
    def leveled(self, ctx, event: LeveledUp):
        if event.hero.owner is not None:
            play(ctx, ctx.config(Sounds).level_up, to=event.hero.owner)

    def update(self, ctx, dt):
        music = ctx.get(MusicIntensity)
        if music.value > 0:
            music.value = max(0.0, music.value - INTENSITY_DECAY * dt)


@system("match_music", runs_on="client")
class MatchMusic(System):
    """Each client's music: the menu bed while drafting and after the match, the match
    bed with its pulse / drive / swell stems in play, the stems following the server's
    intensity (the template's music states and layers)."""

    def update(self, ctx, dt):
        state = ctx.get(MusicState)
        wanted = 2 if ctx.get(Match).phase is Phase.PLAYING else 1
        if wanted != state.playing:
            state.playing = wanted
            if wanted == 2:
                ctx.audio.music(Assets.music.mus_bed, fade=1.5, layers=[
                    MusicLayer(Assets.music.mus_pulse, at=0.3, volume=0.5),
                    MusicLayer(Assets.music.mus_drive, at=0.55, volume=0.6),
                    MusicLayer(Assets.music.mus_swell, at=0.78, volume=0.55),
                ])
            else:
                ctx.audio.music(Assets.music.mus_menu, fade=1.5)
        target = ctx.get(MusicIntensity).value
        if abs(ctx.audio.intensity - target) > 0.02:
            ctx.audio.set_intensity(target, fade=0.5)
