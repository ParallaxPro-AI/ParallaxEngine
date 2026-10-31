from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("armchair: the prefab spawns and its model's controls work")
async def test_armchair(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.armchair, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("recline", 14.0)
    assert abs(model.joint("recline") - 14.0) < 1e-3
    model.set_option("style", "club")
    assert model.option("style") == "club"
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 2.38
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
