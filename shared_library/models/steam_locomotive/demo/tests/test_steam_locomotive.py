from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("steam_locomotive: the prefab spawns and its model's controls work")
async def test_steam_locomotive(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.steam_locomotive, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("smokebox_door", 55.0)
    assert abs(model.joint("smokebox_door") - 55.0) < 1e-3
    model.set_option("livery", "green")
    assert model.option("livery") == "green"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
