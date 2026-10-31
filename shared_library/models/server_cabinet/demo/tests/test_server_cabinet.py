from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("server_cabinet: the prefab spawns and its model's controls work")
async def test_server_cabinet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.server_cabinet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("server", 0.21)
    assert abs(model.joint("server") - 0.21) < 1e-3
    model.set_option("load", "half")
    assert model.option("load") == "half"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
