from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dumpling_stall: the prefab spawns and its model's controls work")
async def test_dumpling_stall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dumpling_stall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("steamer_lid", 0.11)
    assert abs(model.joint("steamer_lid") - 0.11) < 1e-3
    model.set_option("noren", "red")
    assert model.option("noren") == "red"
    assert model.socket_position("socket_vendor").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
