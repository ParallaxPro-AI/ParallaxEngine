from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bean_bag: the prefab spawns and its model's controls work")
async def test_bean_bag(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bean_bag, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("squash", 0.9)
    assert abs(model.joint("squash") - 0.9) < 1e-3
    model.set_option("cover", "navy")
    assert model.option("cover") == "navy"
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
