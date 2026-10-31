from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("trireme: the prefab spawns and its model's controls work")
async def test_trireme(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.trireme, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steering_oars", 0.225)
    assert abs(model.joint("steering_oars") - 0.225) < 1e-3
    assert model.socket_position("waterline").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
