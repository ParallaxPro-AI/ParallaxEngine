from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("snowboard: the prefab spawns and its model's controls work")
async def test_snowboard(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.snowboard, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("binding_front_hb", 31.0)
    assert abs(model.joint("binding_front_hb") - 31.0) < 1e-3
    model.set_option("topsheet", "white")
    assert model.option("topsheet") == "white"
    assert model.socket_position("stand_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
