from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("energy_sword: the prefab spawns and its model's controls work")
async def test_energy_sword(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.energy_sword, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("blade", 0.51)
    assert abs(model.joint("blade") - 0.51) < 1e-3
    model.set_option("blade_color", "red")
    assert model.option("blade_color") == "red"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
