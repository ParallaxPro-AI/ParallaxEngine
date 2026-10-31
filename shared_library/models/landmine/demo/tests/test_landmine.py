from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("landmine: the prefab spawns and its model's controls work")
async def test_landmine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.landmine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pressure_plate", 0.014)
    assert abs(model.joint("pressure_plate") - 0.014) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
