from parallax import Behavior, TriggerEntered, behavior, on
from project import Text

from game.rules import Sounds
from game.components import Gate, KeyFor


@behavior("gate_key", requires=[KeyFor])
class GateKey(Behavior):
    """A floor key: picking it up unlocks every gate of its lock (0 is the boss's)."""

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        lock = self.entity.get(KeyFor).lock
        for _, gate in ctx.world.query(Gate):
            if gate.lock == lock:
                gate.locked = False
        ctx.ui.toast(Text.gate_opens)
        ctx.audio.play(ctx.config(Sounds).relic)
        self.entity.destroy()
