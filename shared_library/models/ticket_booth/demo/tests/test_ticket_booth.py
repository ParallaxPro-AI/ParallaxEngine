from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ticket_booth: the prefab spawns and its model's controls work")
async def test_ticket_booth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ticket_booth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shutter", 37.5)
    assert abs(model.joint("shutter") - 37.5) < 1e-3
    assert model.socket_position("socket_counter").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
