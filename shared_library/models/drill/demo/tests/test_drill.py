from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("drill: the prefab spawns and its model's controls work")
async def test_drill(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.drill, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trigger", 12.0)
    assert abs(model.joint("trigger") - 12.0) < 1e-3
    model.set_option("power", "corded")
    assert model.option("power") == "corded"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
