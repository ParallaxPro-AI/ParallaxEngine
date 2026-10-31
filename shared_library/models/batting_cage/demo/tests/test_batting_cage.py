from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("batting_cage: the prefab spawns and its model's controls work")
async def test_batting_cage(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.batting_cage, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_flap", 37.5)
    assert abs(model.joint("door_flap") - 37.5) < 1e-3
    model.set_option("net", "green")
    assert model.option("net") == "green"
    assert model.socket_position("socket_home_plate").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
