from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hammock_stand: the prefab spawns and its model's controls work")
async def test_hammock_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hammock_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hammock", 0.0)
    assert abs(model.joint("hammock") - 0.0) < 1e-3
    model.set_option("stripe", "red")
    assert model.option("stripe") == "red"
    assert model.socket_position("socket_lie").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
