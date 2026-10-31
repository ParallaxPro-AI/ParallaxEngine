from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bread_rack: the prefab spawns and its model's controls work")
async def test_bread_rack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bread_rack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame_finish", "oak")
    assert model.option("frame_finish") == "oak"
    assert model.socket_position("socket_shelf_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
