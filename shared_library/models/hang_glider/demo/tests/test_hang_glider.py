from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hang_glider: the prefab spawns and its model's controls work")
async def test_hang_glider(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hang_glider, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("control_frame", 0.0)
    assert abs(model.joint("control_frame") - 0.0) < 1e-3
    model.set_option("sail", "red")
    assert model.option("sail") == "red"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
