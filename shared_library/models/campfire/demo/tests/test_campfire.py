from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("campfire: the prefab spawns and its model's controls work")
async def test_campfire(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.campfire, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("damp", 0.4)
    assert abs(model.joint("damp") - 0.4) < 1e-3
    assert model.socket_position("socket_fire").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
