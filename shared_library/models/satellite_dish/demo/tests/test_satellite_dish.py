from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("satellite_dish: the prefab spawns and its model's controls work")
async def test_satellite_dish(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.satellite_dish, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("elevation", 35.0)
    assert abs(model.joint("elevation") - 35.0) < 1e-3
    model.set_option("mount", "roof")
    assert model.option("mount") == "roof"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
