from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fishing_net_rack: the prefab spawns and its model's controls work")
async def test_fishing_net_rack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fishing_net_rack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("net", "green")
    assert model.option("net") == "green"
    assert model.socket_position("mender").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
