from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("campfire_cooking_tripod: the prefab spawns and its model's controls work")
async def test_campfire_cooking_tripod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.campfire_cooking_tripod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("damp", 0.25)
    assert abs(model.joint("damp") - 0.25) < 1e-3
    assert model.socket_position("socket_pot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
