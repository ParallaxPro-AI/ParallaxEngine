from parallax import Behavior, TriggerEntered, behavior, on, param, state
from parallax.combat import Health

from game.config import Sounds
from game.battlefield import ground_y, shell_burst
from game.components import EnemyTank, PlayerTank, Shellfire


@behavior("enemy_shell")
class EnemyShell(Behavior):
    """A travelling enemy shell: real flight time, so it can be dodged or blocked by
    cover. It passes through other enemy hulls and bursts on anything else (the ground,
    a wall, a fuel drum, you); only your hull takes its damage."""

    damage: float = param(15, min=0)
    lifetime: float = param(6, unit="s")

    spent: bool = state(False)

    def start(self, ctx):
        self.entity.destroy(after=self.lifetime)

    def update(self, ctx, dt):
        point = self.entity.transform.position
        if not self.spent and point.y <= ground_y(ctx, point):
            self.spent = True
            shell_burst(ctx, point)  # a miss in the dirt: cover and ridges matter
            self.entity.destroy()

    @on(TriggerEntered)
    def burst(self, ctx, event):
        if self.spent or event.target.has(EnemyTank):
            return
        self.spent = True
        point = self.entity.transform.position
        if event.target.has(PlayerTank):
            event.target.get(Health).damage(self.damage, source=self.entity, kind=Shellfire, point=point)
            ctx.audio.play(ctx.config(Sounds).cannon, volume=0.5)
        shell_burst(ctx, point)
        self.entity.destroy()
