from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bird_cage: the prefab spawns and its model's controls work")
async def test_bird_cage(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bird_cage, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("swing", 0.0)
    assert abs(model.joint("swing") - 0.0) < 1e-3
    model.set_option("finish", "white")
    assert model.option("finish") == "white"
    assert model.socket_position("socket_perch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
