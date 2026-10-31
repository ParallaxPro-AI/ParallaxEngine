"""The Lantern Hollows plate puzzle."""

from parallax import System, TriggerEntered, on, system, vec3
from project import Text

from game.audio import Sounds, play
from game.components import CrystalPlate, Level, VaultBridge, player_touches
from game.config import Rules
from game.resources import Attempt, alive


@system("lantern_vault", scenes=[Level])
class LanternVault(System):
    """Two crystal plates, one on the trail and one on a little isle off it. Each
    lights on the first step and stays lit. With every plate lit, the crystal
    bridge rises out of the dark below the level to the Lantern Vault (a heart
    and three gems). Levels without plates are untouched."""

    def start(self, ctx):
        for entity, plate in ctx.world.query(CrystalPlate):
            entity.child("glow").visible = plate.lit
        if not self.all_lit(ctx):
            for bridge in ctx.world.query(tagged=VaultBridge):
                bridge.visible = False

    @on(TriggerEntered, when=alive, where=player_touches(CrystalPlate))
    def stepped(self, ctx, event: TriggerEntered):
        plate = event.entity.get(CrystalPlate)
        if plate.lit:
            return
        plate.lit = True
        event.entity.child("glow").visible = True
        attempt = ctx.get(Attempt)
        if not self.all_lit(ctx):
            play(ctx, ctx.config(Sounds).plate)
            self.notice(ctx, attempt, Text.notice_plate, seconds=5)
            return
        play(ctx, ctx.config(Sounds).vault)
        self.notice(ctx, attempt, Text.notice_vault, seconds=7)
        rise = ctx.config(Rules).vault_bridge_rise
        for bridge in ctx.world.query(tagged=VaultBridge):
            bridge.visible = True
            bridge.transform.move_to(bridge.transform.position + vec3(0, rise, 0),
                                     rise / ctx.config(Rules).vault_bridge_speed, ease="out_quad")

    def all_lit(self, ctx) -> bool:
        return all(plate.lit for _, plate in ctx.world.query(CrystalPlate))

    def notice(self, ctx, attempt: Attempt, text, seconds: float):
        attempt.notice, attempt.notice_until = ctx.text(text), ctx.time.now + seconds
