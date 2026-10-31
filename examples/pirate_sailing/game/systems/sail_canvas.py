from parallax import Animator, System, system

from game.components import CrewShip, Rig


@system("sail_canvas", runs_on="client")
class SailCanvas(System):
    """Draws every ship's canvas at the hoist its helm has set. Pure presentation, so
    it runs on each client from the replicated `Rig.sail`."""

    def late_update(self, ctx, dt):
        for _, rig, sails in ctx.world.query(Rig, Animator, tagged=CrewShip):
            sails.set_param("hoist", rig.sail)
