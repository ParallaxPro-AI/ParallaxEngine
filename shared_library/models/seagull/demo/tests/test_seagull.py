from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("seagull: the prefab spawns and its model's controls work")
async def test_seagull(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.seagull, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head_turn", 0.0)
    assert abs(model.joint("head_turn") - 0.0) < 1e-3
    assert model.socket_position("beak").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
