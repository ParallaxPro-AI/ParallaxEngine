from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chest_freezer: the prefab spawns and its model's controls work")
async def test_chest_freezer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chest_freezer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 40.0)
    assert abs(model.joint("lid") - 40.0) < 1e-3
    model.set_option("finish", "stainless")
    assert model.option("finish") == "stainless"
    assert model.socket_position("socket_inside").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
