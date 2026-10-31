from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mars_rover: the prefab spawns and its model's controls work")
async def test_mars_rover(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mars_rover, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("mast_pan", 0.0)
    assert abs(model.joint("mast_pan") - 0.0) < 1e-3
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
