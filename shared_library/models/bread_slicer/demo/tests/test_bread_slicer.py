from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bread_slicer: the prefab spawns and its model's controls work")
async def test_bread_slicer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bread_slicer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("pusher", 0.09)
    assert abs(model.joint("pusher") - 0.09) < 1e-3
    model.set_option("finish", "white")
    assert model.option("finish") == "white"
    assert model.socket_position("output_tray").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
