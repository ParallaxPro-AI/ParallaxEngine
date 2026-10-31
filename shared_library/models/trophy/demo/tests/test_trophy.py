from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("trophy: the prefab spawns and its model's controls work")
async def test_trophy(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.trophy, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("metal", "gold")
    assert model.option("metal") == "gold"
    assert model.socket_position("socket_bowl").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
