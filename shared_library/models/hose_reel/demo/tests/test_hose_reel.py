from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hose_reel: the prefab spawns and its model's controls work")
async def test_hose_reel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hose_reel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame_colour", "graphite")
    assert model.option("frame_colour") == "graphite"
    assert model.socket_position("socket_handle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
