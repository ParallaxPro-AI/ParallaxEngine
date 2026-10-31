from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("slot_machine: the prefab spawns and its model's controls work")
async def test_slot_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.slot_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("belly_door", 50.0)
    assert abs(model.joint("belly_door") - 50.0) < 1e-3
    model.set_option("trim", "blue")
    assert model.option("trim") == "blue"
    assert model.socket_position("player_spot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
