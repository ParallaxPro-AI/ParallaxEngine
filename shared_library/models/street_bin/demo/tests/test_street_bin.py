from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("street_bin: the prefab spawns and its model's controls work")
async def test_street_bin(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.street_bin, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flap", 36.0)
    assert abs(model.joint("flap") - 36.0) < 1e-3
    assert model.socket_position("socket_contents").distance_to(thing.transform.position) < 2.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
