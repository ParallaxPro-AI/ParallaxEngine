from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("venetian_gondola: the prefab spawns and its model's controls work")
async def test_venetian_gondola(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.venetian_gondola, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("oar", 0.0)
    assert abs(model.joint("oar") - 0.0) < 1e-3
    assert model.socket_position("waterline").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
