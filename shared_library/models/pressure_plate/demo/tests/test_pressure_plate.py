from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pressure_plate: the prefab spawns and its model's controls work")
async def test_pressure_plate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pressure_plate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("plate", 0.0125)
    assert abs(model.joint("plate") - 0.0125) < 1e-3
    model.set_option("mount", "wall")
    assert model.option("mount") == "wall"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
