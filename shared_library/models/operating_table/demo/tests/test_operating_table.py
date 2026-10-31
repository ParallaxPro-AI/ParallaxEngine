from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("operating_table: the prefab spawns and its model's controls work")
async def test_operating_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.operating_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("height", 0.125)
    assert abs(model.joint("height") - 0.125) < 1e-3
    model.set_option("pads", "midnight")
    assert model.option("pads") == "midnight"
    assert model.socket_position("socket_patient").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
