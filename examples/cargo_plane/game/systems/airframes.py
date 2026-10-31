from parallax import Color, Effect, System, Vec3, on, system
from parallax.characters import Character
from parallax.physics import Rigidbody
from parallax.vehicles import Vehicle
from project import Placed, Scenes, Text

from game.board import roll_offers
from game.components import Berth, Plane
from game.config import FreightRules
from game.cues import Cues, play
from game.events import CareerEnded, PlaneLost
from game.feed import Kind, say
from game.resources import Board, Career
from game.rules import airframes_left, pilot


@system("airframes", scenes=[Scenes.archipelago])
class Airframes(System):
    """Losing a plane — ditched in the sea or broken on a runway — costs an airframe,
    the salvage fee and the load aboard. A replacement waits on the home strip with the
    pilot beside it; losing the last airframe ends the career."""

    @on(PlaneLost)
    def lose_airframe(self, ctx, event):
        rules = ctx.config(FreightRules)
        career = ctx.get(Career)
        fee = min(career.money, rules.ditch_fee)
        career.money -= fee
        career.airframes_lost += 1

        wreck = event.plane.transform.position
        ctx.camera.main.shake(1.0, 0.7)
        ctx.ui.flash(event.plane, color=Color.hex("#ff2a2a"))
        play(ctx, ctx.config(Cues).plane_lost)
        ctx.vfx.play(Effect.explosion, at=Vec3(wreck.x, max(rules.water_level, wreck.y) + 0.5, wreck.z))

        self.back_to_the_hangar(ctx, event.plane)
        board = ctx.get(Board)
        board.contract = None
        board.loaded = False
        roll_offers(ctx, rules.home)
        ctx.save.save("career")

        if airframes_left(ctx) <= 0:
            ctx.emit(CareerEnded(won=False))
            return
        headline = Text.ditched if event.ditched else Text.crashed
        say(ctx, ctx.text(headline, fee=int(fee), left=airframes_left(ctx)), Kind.BAD)

    def back_to_the_hangar(self, ctx, aircraft):
        """The lost plane goes to the home berth — or, when another plane is parked there,
        back to its own — and the pilot stands beside the home berth."""
        walker = pilot(ctx)
        if walker.get(Character).vehicle is not None:
            aircraft.get(Vehicle).exit(walker)
        home = ctx.world.placed(Placed.plane).get(Berth)
        taken = ctx.world.query(tagged=Plane).near(home.position, 15).where(lambda e: e != aircraft).count() > 0
        berth = aircraft.get(Berth) if taken else home
        aircraft.get(Rigidbody).teleport(berth.position, rotation=Vec3(0, berth.heading, 0))
        beside = Vec3(home.position.x - 4, home.position.y + 1, home.position.z - 9)
        walker.get(Character).teleport(beside)
