from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hydro_dam_gate: the prefab spawns and its model's controls work")
async def test_hydro_dam_gate(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hydro_dam_gate, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gate_l", 15.0)
    assert abs(model.joint("gate_l") - 15.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
