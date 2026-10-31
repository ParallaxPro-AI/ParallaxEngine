from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("potion_shelf: the prefab spawns and its model's controls work")
async def test_potion_shelf(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.potion_shelf, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer", 0.09)
    assert abs(model.joint("drawer") - 0.09) < 1e-3
    model.set_option("wood", "oak")
    assert model.option("wood") == "oak"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
