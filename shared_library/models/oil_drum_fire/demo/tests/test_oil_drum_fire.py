from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("oil_drum_fire: the prefab spawns and its model's controls work")
async def test_oil_drum_fire(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.oil_drum_fire, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("damp", 0.35)
    assert abs(model.joint("damp") - 0.35) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
