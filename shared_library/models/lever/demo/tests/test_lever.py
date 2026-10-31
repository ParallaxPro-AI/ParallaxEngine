from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lever: the prefab spawns and its model's controls work")
async def test_lever(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lever, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("handle", 55.0)
    assert abs(model.joint("handle") - 55.0) < 1e-3
    model.set_option("mount", "wall")
    assert model.option("mount") == "wall"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
