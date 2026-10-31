from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gas_cylinder: the prefab spawns and its model's controls work")
async def test_gas_cylinder(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gas_cylinder, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("cap", "off")
    assert model.option("cap") == "off"
    assert model.socket_position("regulator").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
