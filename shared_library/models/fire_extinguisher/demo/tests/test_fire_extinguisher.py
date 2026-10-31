from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fire_extinguisher: the prefab spawns and its model's controls work")
async def test_fire_extinguisher(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fire_extinguisher, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lever", 5.5)
    assert abs(model.joint("lever") - 5.5) < 1e-3
    model.set_option("mount", "wall")
    assert model.option("mount") == "wall"
    assert model.socket_position("nozzle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
