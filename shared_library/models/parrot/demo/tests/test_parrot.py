from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("parrot: the prefab spawns and its model's controls work")
async def test_parrot(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.parrot, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wing_l", 37.5)
    assert abs(model.joint("wing_l") - 37.5) < 1e-3
    model.set_option("plumage", "blue_gold")
    assert model.option("plumage") == "blue_gold"
    assert model.socket_position("perch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
