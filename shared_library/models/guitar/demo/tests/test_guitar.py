from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("guitar: the prefab spawns and its model's controls work")
async def test_guitar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.guitar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tremolo", 8.0)
    assert abs(model.joint("tremolo") - 8.0) < 1e-3
    model.set_option("instrument", "acoustic")
    assert model.option("instrument") == "acoustic"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
