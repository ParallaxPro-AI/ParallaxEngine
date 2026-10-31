from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("space_freighter: the prefab spawns and its model's controls work")
async def test_space_freighter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.space_freighter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("thrust", 5.0)
    assert abs(model.joint("thrust") - 5.0) < 1e-3
    model.set_option("hull", "white")
    assert model.option("hull") == "white"
    assert model.socket_position("socket_pilot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
