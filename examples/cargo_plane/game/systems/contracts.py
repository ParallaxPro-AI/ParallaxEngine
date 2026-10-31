from parallax import Effect, System, Vec3, system
from parallax.vehicles import Vehicle
from project import Scenes, Text

from game.board import roll_offers
from game.config import FreightRules
from game.cues import Cues, play
from game.events import CargoDelivered
from game.feed import Kind, say
from game.resources import Board, Career
from game.rules import depot, interactor, objective, rank


@system("contracts", scenes=[Scenes.archipelago], when=lambda ctx: objective(ctx) is not None)
class Contracts(System):
    """A job's life: the loaders put it aboard when the pilot comes onto the origin pad —
    on foot or in a plane — and the drop-off pays on the destination pad. After a
    delivery the next job (already on the manifest) waits until the pilot leaves the pad
    or signs at the office. Runs only while there is a job.

    In the air, a pass low over the pad counts as being on it, at any speed: a fast low
    buzz collects, cruise altitude doesn't."""

    def fixed_update(self, ctx, dt):
        board = ctx.get(Board)
        here = interactor(ctx)
        pad = depot(ctx, objective(ctx)).transform.position
        if not self.over_pad(ctx, here, pad):
            board.pad_lock = False
        elif board.loaded:
            self.deliver(ctx, pad)
        elif not board.pad_lock:
            self.load(ctx)

    def over_pad(self, ctx, here, pad):
        rules = ctx.config(FreightRules)
        if (here.transform.position - pad).flat().length() > rules.pad_radius:
            return False
        if not here.has(Vehicle) or here.get(Vehicle).grounded:
            return True
        below = ctx.physics.raycast(here.transform.position, Vec3.DOWN, rules.low_pass_height, ignore=[here])
        return below is not None

    def load(self, ctx):
        board = ctx.get(Board)
        board.loaded = True
        board.time_left = board.contract.deadline
        play(ctx, ctx.config(Cues).loaded)
        say(ctx, ctx.text(Text.cargo_loaded, cargo=ctx.text(board.contract.cargo.data.name),
                          island=ctx.text(board.contract.destination.data.name), seconds=int(board.time_left)))

    def deliver(self, ctx, pad):
        board = ctx.get(Board)
        career = ctx.get(Career)
        contract = board.contract
        pay, notes = self.payout(ctx)

        rank_before = rank(ctx)
        career.money += pay
        career.deliveries += 1
        career.distance_flown += contract.leg
        board.contract = None
        board.loaded = False
        board.pad_lock = True  # standing on this pad must not load the next job before you choose
        roll_offers(ctx, contract.destination)

        above = pad + Vec3(0, 3, 0)
        play(ctx, ctx.config(Cues).delivered)
        ctx.vfx.play(Effect.sparkle, at=above, scale=3)
        ctx.ui.float_text(f"+${pay}", at=above)
        say(ctx, ctx.text(Text.delivered, pay=pay, notes=", ".join(ctx.text(note) for note in notes)), Kind.GOOD)
        if rank(ctx) != rank_before:
            promoted = rank(ctx).data
            say(ctx, ctx.text(Text.promoted, rank=ctx.text(promoted.name), blurb=ctx.text(promoted.blurb)), Kind.GOOD)
        ctx.emit(CargoDelivered(pay=pay))
        ctx.save.save("career")

    def payout(self, ctx):
        """The quoted pay, cut for a broken or late load, plus the on-time and greased bonuses."""
        rules = ctx.config(FreightRules)
        board = ctx.get(Board)
        pay = float(board.contract.pay)
        notes = []
        if board.damaged:
            pay *= rules.damaged_factor
            notes.append(Text.note_damaged)
        if board.late:
            pay *= rules.late_factor
            notes.append(Text.note_late)
        else:
            pay += rules.on_time_bonus * board.contract.cargo.data.pay_scale
            notes.append(Text.note_on_time)
        if board.greased:
            pay += rules.grease_bonus
            notes.append(Text.note_greased)
        return round(pay), notes
