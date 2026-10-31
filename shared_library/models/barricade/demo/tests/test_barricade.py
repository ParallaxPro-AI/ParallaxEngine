from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("barricade: the prefab spawns and its model's controls work")
async def test_barricade(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.barricade, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wheel_l", 30.0)
    assert abs(model.joint("wheel_l") - 30.0) < 1e-3
    model.set_option("fortification", "sandbag")
    assert model.option("fortification") == "sandbag"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
