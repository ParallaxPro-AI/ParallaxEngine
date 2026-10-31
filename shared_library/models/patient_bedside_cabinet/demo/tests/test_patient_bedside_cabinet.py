from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("patient_bedside_cabinet: the prefab spawns and its model's controls work")
async def test_patient_bedside_cabinet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.patient_bedside_cabinet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer", 0.16)
    assert abs(model.joint("drawer") - 0.16) < 1e-3
    model.set_option("fronts", "blue")
    assert model.option("fronts") == "blue"
    assert model.socket_position("top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
