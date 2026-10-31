from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("salad_bar: the prefab spawns and its model's controls work")
async def test_salad_bar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.salad_bar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_1", 50.0)
    assert abs(model.joint("door_1") - 50.0) < 1e-3
    model.set_option("body_finish", "green")
    assert model.option("body_finish") == "green"
    assert model.socket_position("tray_slide").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
