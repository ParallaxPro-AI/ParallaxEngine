from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("passport_booth: the prefab spawns and its model's controls work")
async def test_passport_booth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.passport_booth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 50.0)
    assert abs(model.joint("door") - 50.0) < 1e-3
    model.set_option("panel_finish", "white")
    assert model.option("panel_finish") == "white"
    assert model.socket_position("seat_officer").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
