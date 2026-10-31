from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("armor_stand: the prefab spawns and its model's controls work")
async def test_armor_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.armor_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("visor", 39.0)
    assert abs(model.joint("visor") - 39.0) < 1e-3
    model.set_option("finish", "steel")
    assert model.option("finish") == "steel"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
