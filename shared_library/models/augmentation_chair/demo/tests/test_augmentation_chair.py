from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("augmentation_chair: the prefab spawns and its model's controls work")
async def test_augmentation_chair(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.augmentation_chair, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("backrest", 17.5)
    assert abs(model.joint("backrest") - 17.5) < 1e-3
    model.set_option("glow", "magenta")
    assert model.option("glow") == "magenta"
    assert model.socket_position("seat_patient").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
