from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("magic_bolt_projectile: the prefab spawns and its model's controls work")
async def test_magic_bolt_projectile(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.magic_bolt_projectile, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("tip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
