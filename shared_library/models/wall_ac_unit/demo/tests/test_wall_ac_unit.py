from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wall_ac_unit: the prefab spawns and its model's controls work")
async def test_wall_ac_unit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wall_ac_unit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("front_panel", 31.0)
    assert abs(model.joint("front_panel") - 31.0) < 1e-3
    model.set_option("finish", "black")
    assert model.option("finish") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
