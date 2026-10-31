from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gantry_hoist: the prefab spawns and its model's controls work")
async def test_gantry_hoist(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gantry_hoist, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("trolley", 0.0)
    assert abs(model.joint("trolley") - 0.0) < 1e-3
    model.set_option("mount", "monorail")
    assert model.option("mount") == "monorail"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
