from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sliding_door: the prefab spawns and its model's controls work")
async def test_sliding_door(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sliding_door, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf_left", 0.33)
    assert abs(model.joint("leaf_left") - 0.33) < 1e-3
    model.set_option("infill", "glass_clear")
    assert model.option("infill") == "glass_clear"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
