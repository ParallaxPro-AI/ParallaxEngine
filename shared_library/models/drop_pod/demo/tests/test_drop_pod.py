from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("drop_pod: the prefab spawns and its model's controls work")
async def test_drop_pod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.drop_pod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("petal_0", 50.0)
    assert abs(model.joint("petal_0") - 50.0) < 1e-3
    model.set_option("hull", "slate")
    assert model.option("hull") == "slate"
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
