from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("printer: the prefab spawns and its model's controls work")
async def test_printer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.printer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("paper_tray", 0.14)
    assert abs(model.joint("paper_tray") - 0.14) < 1e-3
    model.set_option("config", "office_mfd")
    assert model.option("config") == "office_mfd"
    assert model.socket_position("socket_output").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
