from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("parking_ticket_machine: the prefab spawns and its model's controls work")
async def test_parking_ticket_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.parking_ticket_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("service_door", 52.5)
    assert abs(model.joint("service_door") - 52.5) < 1e-3
    model.set_option("body", "blue")
    assert model.option("body") == "blue"
    assert model.socket_position("socket_ticket").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
