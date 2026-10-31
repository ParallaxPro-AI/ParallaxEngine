from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wood_stove: the prefab spawns and its model's controls work")
async def test_wood_stove(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wood_stove, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 52.5)
    assert abs(model.joint("door") - 52.5) < 1e-3
    model.set_option("fire", "embers")
    assert model.option("fire") == "embers"
    assert model.socket_position("socket_fire").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
