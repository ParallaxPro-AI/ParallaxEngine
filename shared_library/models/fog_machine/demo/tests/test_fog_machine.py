from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fog_machine: the prefab spawns and its model's controls work")
async def test_fog_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fog_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bracket", 45.0)
    assert abs(model.joint("bracket") - 45.0) < 1e-3
    assert model.socket_position("remote").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
