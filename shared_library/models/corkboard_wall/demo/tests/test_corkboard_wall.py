from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("corkboard_wall: the prefab spawns and its model's controls work")
async def test_corkboard_wall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.corkboard_wall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("content", "sparse")
    assert model.option("content") == "sparse"
    assert model.socket_position("socket_pin").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
