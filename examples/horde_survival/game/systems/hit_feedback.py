from parallax import Color, System, on, system, vec3
from parallax.combat import Damaged, Healed
from project import Scenes

from game.components import Build, Foe

HIT_COLOR = Color.hex("#ffe1a8")
DAMAGE_COLOR = Color.hex("#fed7aa")
HEAL_COLOR = Color.hex("#7dd3fc")
NUMBER_HEIGHT = vec3(0, 1.3, 0)


@system("hit_feedback", scenes=[Scenes.arena])
class HitFeedback(System):
    """Every bolt, nova or aura tick that lands flashes the foe warm white for a moment
    and floats the damage over it, and the survivor's own hits and heals float over the
    survivor, so a crowd shows where the damage is going."""

    @on(Damaged, where=lambda event: event.entity.has(Foe) or event.entity.has(Build))
    def damaged(self, ctx, event: Damaged):
        if event.entity.has(Foe):
            ctx.ui.flash(event.entity, color=HIT_COLOR, seconds=0.09)
        ctx.ui.float_text(f"-{round(event.amount)}", event.entity.transform.position + NUMBER_HEIGHT,
                          color=DAMAGE_COLOR)

    @on(Healed, where=lambda event: event.entity.has(Build) and event.amount >= 1)
    def healed(self, ctx, event: Healed):
        ctx.ui.float_text(f"+{round(event.amount)}", event.entity.transform.position + NUMBER_HEIGHT,
                          color=HEAL_COLOR)
