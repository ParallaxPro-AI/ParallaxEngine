import math

from parallax import Behavior, ContentRef, Marker, TriggerEntered, behavior, on, param, state, vec3
from project import Content, Text

from game.arena import give_ammo, give_armor
from game.audio import play
from game.components import Arsenal, Player
from game.content import PickupDef
from game.resources import FeedKind
from game.run import feed


@behavior("pickup", requires=[Marker])
class Pickup(Behavior):
    """A supply crate worth fighting over. Walk through it to take its ammo or armor
    ("AMMO collected" on the centre feed); it's gone until its respawn timer runs out. It
    bobs and spins while it's there."""

    kind: ContentRef[PickupDef] = param(Content.pickup.ammo)
    spin: float = param(90, unit="deg/s")
    bob: float = param(0.25, unit="m")

    ready_at: float = state(0.0)
    rest_y: float = state(0.0)

    def start(self, ctx):
        self.rest_y = self.entity.transform.position.y

    def update(self, ctx, dt):
        t = ctx.time.now
        self.entity.visible = t >= self.ready_at
        self.entity.get(Marker).shown = self.entity.visible
        self.entity.transform.position = self.entity.transform.position.with_y(self.rest_y + self.bob * math.sin(t * math.pi))
        self.entity.transform.euler = vec3(0, (t * self.spin) % 360, 0)

    @on(TriggerEntered)
    def take(self, ctx, event):
        if ctx.time.now < self.ready_at or not event.target.has(Player):
            return
        supply = self.kind.data
        self.ready_at = ctx.time.now + supply.respawn
        give_ammo(event.target.get(Arsenal), supply.ammo)
        give_armor(ctx, event.target, supply.armor)
        feed(ctx, ctx.text(Text.collected, supply=ctx.text(supply.label)), FeedKind.BUFF)
        play(ctx, supply.cue)
