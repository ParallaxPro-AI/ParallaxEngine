from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("boarding_gate_desk: the prefab spawns and its model's controls work")
async def test_boarding_gate_desk(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.boarding_gate_desk, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ped_door", 50.0)
    assert abs(model.joint("ped_door") - 50.0) < 1e-3
    model.set_option("finish", "white")
    assert model.option("finish") == "white"
    assert model.socket_position("socket_agent_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
