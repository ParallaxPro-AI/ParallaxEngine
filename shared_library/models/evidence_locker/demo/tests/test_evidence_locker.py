from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("evidence_locker: the prefab spawns and its model's controls work")
async def test_evidence_locker(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.evidence_locker, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_r0_c0", 52.5)
    assert abs(model.joint("door_r0_c0") - 52.5) < 1e-3
    model.set_option("color", "tan")
    assert model.option("color") == "tan"
    assert model.socket_position("socket_cell_r0_c0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
