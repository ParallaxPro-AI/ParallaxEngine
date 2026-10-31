from parallax import System, Vec3, system
from project import Scenes

from game.components import ShowroomCar
from game.config import RaceRules
from game.resources import Career, GarageMenu


@system("showroom", scenes=[Scenes.garage, Scenes.title])
class Showroom(System):
    """The template's garage lineup: the four cars side by side on the grass, and the
    one you have picked turns slowly on its spot (the rest face the camera). Derived
    from the career every frame, so picking or buying a car needs no extra step."""

    def update(self, ctx, dt):
        shown = ctx.get(GarageMenu).shown if ctx.scenes.current_is(Scenes.garage) else None
        picked = (shown or ctx.get(Career).car).data.showroom
        spin = ctx.config(RaceRules).showroom_spin
        for car in ctx.world.query(tagged=ShowroomCar):
            yaw = (car.transform.euler.y + spin * dt) % 360 if car.prefab == picked else 180
            car.transform.euler = Vec3(0, yaw, 0)
