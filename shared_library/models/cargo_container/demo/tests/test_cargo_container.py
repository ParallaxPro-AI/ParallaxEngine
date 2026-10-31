from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cargo_container: the prefab spawns and its model's controls work")
async def test_cargo_container(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cargo_container, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 52.5)
    assert abs(model.joint("door_l") - 52.5) < 1e-3
    model.set_option("colour", "olive")
    assert model.option("colour") == "olive"
    assert model.socket_position("socket_interior").distance_to(thing.transform.position) < 6.2
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
