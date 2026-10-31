"""The player's lives."""

from parallax import System, on, system
from parallax.characters import Character
from parallax.combat import Died, Health
from project import Scenes, Text

from game.arena import fighting, player, restock, safest_spawn_point
from game.audio import Sounds, play
from game.components import Arsenal, Plating, Player
from game.config import MatchRules
from game.resources import FeedKind, Match, Mods
from game.run import end_run, feed


@system("respawns", scenes=[Scenes.arena])
class Respawns(System):
    """Each death costs a life. With lives left, the player comes back after a short
    delay (the HUD's ELIMINATED overlay counts it down) at the spawn point farthest from
    every bot, restocked. With none, the run is over."""

    @on(Died, when=fighting, where=lambda event: event.entity.has(Player))
    def player_down(self, ctx, event):
        match = ctx.get(Match)
        match.lives -= 1
        match.deaths += 1
        play(ctx, ctx.config(Sounds).player_death)
        feed(ctx, ctx.text(Text.you_were_eliminated), FeedKind.DEATH)
        if match.lives == 0:
            end_run(ctx, won=False)
            return
        match.player_respawn_at = ctx.time.now + ctx.config(MatchRules).respawn_delay

    def update(self, ctx, dt):
        match = ctx.get(Match)
        if match.player_respawn_at < 0 or ctx.time.now < match.player_respawn_at:
            return
        match.player_respawn_at = -1
        you = player(ctx)
        you.get(Character).teleport(safest_spawn_point(ctx).transform.position)
        you.get(Health).revive()
        you.get(Plating).points = ctx.get(Mods).armor_start
        restock(you.get(Arsenal))
