from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("owl: the prefab spawns and its model's controls work")
async def test_owl(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.owl, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("wing_l", 40.0)
    assert abs(model.joint("wing_l") - 40.0) < 1e-3
    model.set_option("plumage", "grey")
    assert model.option("plumage") == "grey"
    assert model.socket_position("talons").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
