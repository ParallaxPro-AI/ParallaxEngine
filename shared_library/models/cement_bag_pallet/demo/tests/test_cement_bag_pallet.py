from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cement_bag_pallet: the prefab spawns and its model's controls work")
async def test_cement_bag_pallet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cement_bag_pallet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("brand", "green")
    assert model.option("brand") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
