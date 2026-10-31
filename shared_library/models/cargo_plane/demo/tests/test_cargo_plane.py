from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cargo_plane: the prefab spawns and its model's controls work")
async def test_cargo_plane(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cargo_plane, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("crew_door", 50.0)
    assert abs(model.joint("crew_door") - 50.0) < 1e-3
    model.set_option("camo", "olive")
    assert model.option("camo") == "olive"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
