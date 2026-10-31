from parallax import Behavior, Context, Entity, Model, behavior, vec3
from project import Assets, Text

from game.actions import ChefControls
from game.components import Chef, Plate, Pot, PotState, Station
from game.content import Item, KitchenSounds
from game.events import DishServed, FoodBinned, StepDone
from game.recipes import Act, Plan, plan, station_in_reach
from game.rules import play, tell


@behavior("chef_hands", requires=[Chef])
class ChefHands(Behavior):
    """The one-button station handler: interact at the nearest station does whatever
    the recipe chain says it does with what's in your hands. It knows nothing about
    food; stations, steps, prompts and sounds are all content. Feedback goes to this
    chef's own task banner."""

    def update(self, ctx, dt):
        if not ctx.input.pressed(ChefControls.interact):
            return
        station = station_in_reach(ctx, self.entity)
        if station is None:
            return
        action = plan(station, self.entity.get(Chef).held)
        if action is None or action.act is Act.WAIT:
            return
        if action.act is Act.TAKE_POT:
            self.take_pot(ctx, station)
        else:
            self.do_step(ctx, station, action)
        ctx.emit(StepDone(by=self.entity))

    def take_pot(self, ctx: Context, stove: Entity) -> None:
        pot = stove.get(Pot)
        chef = self.entity.get(Chef)
        chef.held = pot.contents
        pot.contents = None
        pot.state = PotState.EMPTY
        tell(ctx, self.entity, ctx.text(Text.took, item=ctx.text(chef.held.data.name)))
        play(ctx, ctx.config(KitchenSounds).pickup)
        self.pop(ctx, stove, chef.held.data, 1.4)

    def do_step(self, ctx: Context, station: Entity, action: Plan) -> None:
        step = action.step
        chef = self.entity.get(Chef)
        held = chef.held
        if step.cook_seconds > 0:
            pot = station.get(Pot)
            pot.state = PotState.COOKING
            pot.contents = step.gives
            pot.time_left = step.cook_seconds
            pot.cook_seconds = step.cook_seconds
            pot.burn_seconds = step.burn_seconds
            chef.held = None
        elif step.to_plate:
            station.get(Plate).items.append(held)
            chef.held = None
        elif step.requires_plate:
            plate = station.get(Plate)
            plate.items = [item for item in plate.items if item not in step.requires_plate]
            chef.held = step.gives
        elif step.deliver:
            ctx.emit(DishServed(by=self.entity, item=held))
            chef.held = None
        elif step.discard:
            ctx.emit(FoodBinned(by=self.entity, item=held))
            chef.held = None
        else:
            chef.held = step.gives

        self.swing_door(ctx, station)
        play(ctx, step.cue)
        # A delivery's line comes from the order rail: only it knows whether anyone
        # ordered the dish and what it paid.
        if step.feedback is not None and not step.deliver:
            tell(ctx, self.entity, ctx.text(step.feedback))
        shown = step.gives if step.gives is not None else held
        self.pop(ctx, station, shown.data, 1.1)

    def pop(self, ctx: Context, station: Entity, item: Item, height: float) -> None:
        """A burst of sparks in the food's own colour over the station."""
        ctx.vfx.play(Assets.vfx.pop, at=station.transform.position + vec3(0, height, 0), color=item.carry_color)

    def swing_door(self, ctx: Context, station: Entity) -> None:
        """A station with a door (the fridge) opens it while it is used."""
        kind = station.get(Station).kind.data
        if kind.opens is None:
            return
        model = station.get(Model)
        model.open(kind.opens)
        ctx.time.after(kind.opens_for, lambda: model.close(kind.opens))
