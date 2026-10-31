from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("giant_spider_boss: the prefab spawns and its model's controls work")
async def test_giant_spider_boss(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.giant_spider_boss, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fang_l", 16.0)
    assert abs(model.joint("fang_l") - 16.0) < 1e-3
    model.set_option("carapace", "brown")
    assert model.option("carapace") == "brown"
    assert model.socket_position("mouth").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
