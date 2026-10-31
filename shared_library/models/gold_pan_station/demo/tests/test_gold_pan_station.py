from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gold_pan_station: the prefab spawns and its model's controls work")
async def test_gold_pan_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gold_pan_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cradle", 0.0)
    assert abs(model.joint("cradle") - 0.0) < 1e-3
    assert model.socket_position("socket_panner").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
