from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("egyptian_sarcophagus_gold: the prefab spawns and its model's controls work")
async def test_egyptian_sarcophagus_gold(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.egyptian_sarcophagus_gold, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 44.0)
    assert abs(model.joint("lid") - 44.0) < 1e-3
    model.set_option("finish", "gilt_bronze")
    assert model.option("finish") == "gilt_bronze"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
