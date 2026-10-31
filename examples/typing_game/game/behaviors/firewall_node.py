from parallax import Behavior, Color, Light, Shape, Vec3, behavior, on, param, state

from game.events import WordBreached, WordCleared


@behavior("firewall_node", requires=[Shape, Light])
class FirewallNode(Behavior):
    """One node of the firewall, under one column. It flashes green when a word is
    purged in its column and red when one breaches there, so the firewall shows
    where the player is winning and where they aren't. Its column is wherever it is
    placed: words within `reach` of its x are its own."""

    idle_color: Color = param(Color.hex("#6f8b95"))
    clear_color: Color = param(Color.hex("#95ffc4"))
    breach_color: Color = param(Color.hex("#ff9599"))
    decay: float = param(6.0, doc="Flash fades at this many full-strengths per second.")
    reach: float = param(1.4, unit="m")
    lift: float = param(0.6, doc="Extra height at full flash, as a fraction.")
    glow: float = param(9.0, doc="Light intensity added at full flash.")
    flash: float = state(0.0)
    flash_color: Color = state(Color.WHITE)
    base_scale: Vec3 = state(Vec3.ONE)
    base_intensity: float = state(0.0)

    def start(self, ctx):
        self.base_scale = self.entity.transform.scale
        self.base_intensity = self.entity.get(Light).intensity

    @on(WordCleared)
    def cleared(self, ctx, event):
        self.punch(event.at.x, self.clear_color)

    @on(WordBreached)
    def breached(self, ctx, event):
        self.punch(event.at.x, self.breach_color)

    def punch(self, x, color):
        if abs(x - self.entity.transform.position.x) < self.reach:
            self.flash = 1.0
            self.flash_color = color

    def update(self, ctx, dt):
        self.flash = max(0.0, self.flash - self.decay * dt)
        self.entity.get(Shape).color = self.idle_color.lerp(self.flash_color, self.flash)
        self.entity.transform.scale = self.base_scale.with_y(self.base_scale.y * (1 + self.lift * self.flash))
        light = self.entity.get(Light)
        light.intensity = self.base_intensity + self.glow * self.flash
        light.color = self.flash_color
