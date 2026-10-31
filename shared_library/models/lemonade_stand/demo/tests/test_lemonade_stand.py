from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lemonade_stand: the prefab spawns and its model's controls work")
async def test_lemonade_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lemonade_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cash_lid", 50.0)
    assert abs(model.joint("cash_lid") - 50.0) < 1e-3
    model.set_option("panel", "pink")
    assert model.option("panel") == "pink"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
