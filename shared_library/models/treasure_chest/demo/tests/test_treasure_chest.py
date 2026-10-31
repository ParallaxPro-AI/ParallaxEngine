from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("treasure_chest: the prefab spawns and its model's controls work")
async def test_treasure_chest(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.treasure_chest, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 52.5)
    assert abs(model.joint("lid") - 52.5) < 1e-3
    model.set_option("style", "iron")
    assert model.option("style") == "iron"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
