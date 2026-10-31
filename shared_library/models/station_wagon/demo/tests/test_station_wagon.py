from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("station_wagon: the prefab spawns and its model's controls work")
async def test_station_wagon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.station_wagon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("body_shell_boot", 40.0)
    assert abs(model.joint("body_shell_boot") - 40.0) < 1e-3
    model.set_option("paint", "teal")
    assert model.option("paint") == "teal"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
