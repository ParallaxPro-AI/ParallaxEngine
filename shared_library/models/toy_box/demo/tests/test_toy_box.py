from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("toy_box: the prefab spawns and its model's controls work")
async def test_toy_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.toy_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 50.0)
    assert abs(model.joint("lid") - 50.0) < 1e-3
    model.set_option("paint", "red")
    assert model.option("paint") == "red"
    assert model.socket_position("socket_cavity").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
