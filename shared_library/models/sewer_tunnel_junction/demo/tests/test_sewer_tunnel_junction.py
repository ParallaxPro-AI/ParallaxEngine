from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sewer_tunnel_junction: the prefab spawns and its model's controls work")
async def test_sewer_tunnel_junction(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sewer_tunnel_junction, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sluice_gate", 0.225)
    assert abs(model.joint("sluice_gate") - 0.225) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
