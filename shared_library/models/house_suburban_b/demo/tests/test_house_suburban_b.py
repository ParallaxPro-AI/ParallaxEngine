from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("house_suburban_b: the prefab spawns and its model's controls work")
async def test_house_suburban_b(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.house_suburban_b, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 47.0)
    assert abs(model.joint("door") - 47.0) < 1e-3
    model.set_option("siding_colour", "sage")
    assert model.option("siding_colour") == "sage"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
