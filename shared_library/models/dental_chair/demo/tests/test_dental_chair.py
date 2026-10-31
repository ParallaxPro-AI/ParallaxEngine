from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dental_chair: the prefab spawns and its model's controls work")
async def test_dental_chair(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dental_chair, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lift", 0.125)
    assert abs(model.joint("lift") - 0.125) < 1e-3
    model.set_option("upholstery", "blue")
    assert model.option("upholstery") == "blue"
    assert model.socket_position("socket_patient").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
