from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fish_goldfish: the prefab spawns and its model's controls work")
async def test_fish_goldfish(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fish_goldfish, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("jaw", 13.0)
    assert abs(model.joint("jaw") - 13.0) < 1e-3
    assert model.socket_position("mouth").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
