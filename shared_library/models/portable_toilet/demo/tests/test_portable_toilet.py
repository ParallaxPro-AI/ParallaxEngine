from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("portable_toilet: the prefab spawns and its model's controls work")
async def test_portable_toilet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.portable_toilet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 52.5)
    assert abs(model.joint("door") - 52.5) < 1e-3
    model.set_option("colour", "green")
    assert model.option("colour") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
