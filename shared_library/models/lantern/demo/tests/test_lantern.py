from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lantern: the prefab spawns and its model's controls work")
async def test_lantern(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lantern, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("carry_handle", 50.0)
    assert abs(model.joint("carry_handle") - 50.0) < 1e-3
    model.set_option("element", "electric")
    assert model.option("element") == "electric"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
