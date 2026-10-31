from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("siege_tower: the prefab spawns and its model's controls work")
async def test_siege_tower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.siege_tower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ramp", 45.0)
    assert abs(model.joint("ramp") - 45.0) < 1e-3
    model.set_option("cladding", "hides")
    assert model.option("cladding") == "hides"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
