from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("walk_in_shower_glass: the prefab spawns and its model's controls work")
async def test_walk_in_shower_glass(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.walk_in_shower_glass, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("temp", 60.0)
    assert abs(model.joint("temp") - 60.0) < 1e-3
    model.set_option("walls", "large_format")
    assert model.option("walls") == "large_format"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
