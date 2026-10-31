from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("warp_gate_ring: the prefab spawns and its model's controls work")
async def test_warp_gate_ring(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.warp_gate_ring, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("horizon", "violet")
    assert model.option("horizon") == "violet"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
