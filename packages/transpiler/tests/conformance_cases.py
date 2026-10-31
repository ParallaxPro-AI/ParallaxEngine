"""Conformance snippets: each runs under CPython and compiled under Node; outputs must match
exactly (print output, plus "<Type>: <message>" for an uncaught exception).

Values whose int/float kind is ambiguous at runtime (an integral float of unknown kind) are
avoided on purpose; that gap is documented in pyrt/values.ts.
"""

CASES: dict[str, str] = {}


def case(name: str, source: str) -> None:
    assert name not in CASES, name
    CASES[name] = source


# ── Literals, str and repr ──────────────────────────────────────────────────────

case("literals", r'''
print(1, -2, 3.5, 1e16, 1.5e-7, 0.1 + 0.2, 1/3, -0.0, True, False, None)
print(repr("it's"), repr('say "hi"'), repr("both ' and \""), repr("tab\tnl\n\x01é"))
print([1, "a", (2,), (), [3, [4]]], (1, 2), {"k": [1, 2]}, set(), {1})
print(str(2.0), str(10 / 4), repr(100.0), 1e22, 123456789012345678.0, 2 ** 52 + 0.5)
print(float("inf"), float("-inf"), -float("inf"), 1e300 * 1e10)
''')

case("fstrings", r'''
x = 3.14159
n = 42
s = "hi"
print(f"{x:.2f} {x:.0f} {n:5d}|{n:<5}|{n:^7}|{n:>4}| {s!r} {s:>6} {s:*^7}")
print(f"{n:08.3f} {-n:+d} {n:+d} {n: d} {1234567:,} {1234567:_} {255:x} {255:#X} {5:b} {8:#o}")
print(f"{0.5:%} {0.125:.2f} {0.375:.2f} {2.675:.2f} {1e-5:g} {123456789.0:g} {0.0001:g} {1.5:e} {12345.678:.3e}")
print(f"{123.0:.3} {12.0:.3} {1.0:.3} {0.1:.1%} {-0.0001:z.2f} {1234.5:010,.1f} {3:03d} {-3:05d}")
print(f"{x=}", f"{n=:>4}", f"{'nested'!s:>{n // 6}}", f"{{braces}}")
print(f"{True} {None} {[1, 'a']} {True:>5} {3.0:g} {2.5:.0f} {3.5:.0f}")
w = 7
print(f"{x:{w}.{2}f}|")
print(format(12, "04d"), format(0.1, ".20f"), format("ab", "<4") + "|")
''')

case("int_float_division", r'''
print(7 // 2, -7 // 2, 7 // -2, -7 // -2, 7 % 3, -7 % 3, 7 % -3, -7 % -3)
print(7.5 // 2, -7.5 // 2, 7.5 % 2, -7.5 % 2, 5.0 % -3, divmod(-7, 2), divmod(7, -2))
print(7 / 2, 2 ** 10, 2 ** -1, (-2) ** 3, 10 ** 15, abs(-3), abs(-2.5), -(-4))
print(round(2.5), round(3.5), round(-2.5), round(0.5), round(1.5), round(2.675, 2), round(1234, -2), round(1250, -2), round(1350, -2))
print(round(0.125, 2), round(0.375, 2), round(-1.005, 2), round(7.0 / 3, 3))
print(int(3.9), int(-3.9), int("  42 "), int("-1_000"), int("ff", 16), float("1e3"), float(" -2.5 "))
print(1 << 40, 1 << 3, 255 >> 2, 5 & 3, 5 | 3, 5 ^ 3, ~5, True + True, True & False, True | False)
print(min(3, 1, 2), max([4, 9, 2]), min("b", "a"), max([], default=0), min([(2, "b"), (1, "z")]))
print(sum([1, 2, 3]), sum([0.1] * 10) == 1.0, sum([0.1, 0.2]), sum([1, 2], 10), sum([[1], [2]], []), pow(3, 4, 5), pow(2, 0.5))
''')

case("zero_division", r'''
try:
    1 / 0
except ZeroDivisionError as e:
    print("caught", e)
try:
    5 // 0
except ZeroDivisionError as e:
    print("caught", e)
try:
    5 % 0
except ZeroDivisionError as e:
    print("caught", e)
print(10 % 0.0)
''')

case("comparisons", r'''
a, b, c = 1, 2, 3
print(a < b < c, a < b > c, 1 == 1.0, 1 == True, "a" < "b", [1, 2] < [1, 3], (1, 2) == (1, 2), [1] == (1,))
print(None is None, a is not None, [] == [], {} == {}, {1: 2} == {1: 2}, {1, 2} == {2, 1}, "x" != "y")
print(1 in [1, 2], 3 not in (1, 2), "ell" in "hello", "k" in {"k": 1}, 2 in {1, 2}, 4 in range(0, 10, 2), 5 in range(0, 10, 2))
print((1, "a") < (1, "b"), [3] > [2, 9], "Z" < "a", "abc" <= "abd")
def side(x):
    print("eval", x)
    return x
print(side(1) < side(2) < side(0) < side(5))
try:
    print(1 < "a")
except TypeError as e:
    print("TypeError", e)
''')

case("truthiness", r'''
for v in [0, 1, -1.5, "", "a", [], [0], (), {}, {0: 0}, set(), None, True, False, range(0), range(2)]:
    print(repr(v), bool(v), "yes" if v else "no", not v)
print(0 or "x", 1 and "y", [] or [] or 7, 1 and 0 and 2, None or None)
class Empty:
    def __len__(self):
        return 0
class Falsy:
    def __bool__(self):
        return False
print(bool(Empty()), bool(Falsy()), "e" if Empty() else "f")
''')

case("strings", r'''
s = "  Hello, World  "
print(s.strip(), s.lstrip() + "|", s.rstrip() + "|", s.lower(), s.upper(), s.split(), s.split(","), s.strip().split(", "))
print("a,b,,c".split(","), "a b  c".split(" "), "a,b,c".split(",", 1), "a,b,c".rsplit(",", 1), "  a  b ".split(None, 1))
print("-".join(["x", "y", "z"]), "".join([]), "abc".replace("b", "B"), "aaa".replace("a", "b", 2), "ab".replace("", "-"))
print("hello".find("l"), "hello".rfind("l"), "hello".find("z"), "hello".index("e"), "hello".count("l"), "aaaa".count("aa"))
print("hello".startswith("he"), "hello".endswith(("x", "lo")), "Hello World".title(), "hello world".capitalize(), "AbC".swapcase())
print("42".isdigit(), "4a".isdigit(), "abc".isalpha(), "ab1".isalnum(), "   ".isspace(), "ABC".isupper(), "abc".islower(), "Ab".isupper())
print("ab".center(7, "*"), "ab".center(6), "abc".center(6), "7".zfill(3), "-7".zfill(4), "ab".ljust(4, ".") + "|", "ab".rjust(4))
print("a=b=c".partition("="), "a=b=c".rpartition("="), "nope".partition("="), "prefix_x".removeprefix("prefix_"), "x.py".removesuffix(".py"))
print("line1\nline2\r\nline3".splitlines(), "x\ny\n".splitlines(True))
print(len("héllo"), "héllo"[1], "abcdef"[1:4], "abcdef"[::-1], "abcdef"[-2:], "abcdef"[::2], "abc" * 3, "ab" + "cd")
print(str(5) + "!", repr([1, "x"]), str(None), "%" in "100%", ord("A"), chr(9731), "a" < "B")
t = "x"
t += "y"
print(t, "café".upper(), "ß".upper(), "ǅ".lower())
''')

case("string_errors", r'''
try:
    "a" + 1
except TypeError as e:
    print(e)
try:
    "abc".index("z")
except ValueError as e:
    print(e)
try:
    "abc"[10]
except IndexError as e:
    print(e)
try:
    ",".join([1])
except TypeError as e:
    print(e)
''')

case("lists", r'''
xs = [3, 1, 2]
xs.append(4)
xs.extend([5, 6])
xs.insert(0, 0)
xs.insert(-1, 9)
xs.insert(100, 7)
print(xs, len(xs), xs[0], xs[-1], xs[1:3], xs[::-2], xs[-3:], xs[:100], xs[5:2])
print(xs.pop(), xs.pop(0), xs, xs.index(2), xs.count(9))
xs.remove(9)
xs.sort()
print(xs)
xs.sort(reverse=True)
print(xs)
xs.reverse()
print(xs, xs.copy() == xs, xs.copy() is xs)
words = ["bb", "a", "ccc", "dd"]
words.sort(key=len)
print(words, sorted(words), sorted(words, key=len, reverse=True), sorted([3, 1, 2], reverse=True))
ys = xs
ys += [100]
print(xs, ys is xs, [1, 2] * 2, [0] * 3, 2 * [1], [[0] * 2 for _ in range(2)])
xs[1] = "one"
xs[1:3] = ["a", "b", "c"]
print(xs)
del xs[0]
print(xs)
xs.clear()
print(xs, list(range(5)), list("abc"), list((1, 2)), list({"a": 1, "b": 2}))
''')

case("list_errors", r'''
xs = [1]
try:
    xs[5]
except IndexError as e:
    print("IndexError", e)
try:
    xs.remove(9)
except ValueError as e:
    print("ValueError", e)
try:
    [].pop()
except IndexError as e:
    print("IndexError", e)
try:
    xs.index(7)
except ValueError as e:
    print("ValueError", e)
try:
    xs["a"]
except TypeError as e:
    print("TypeError", e)
print(xs[-1])
''')

case("tuples_unpacking", r'''
t = (1, 2, 3)
a, b, c = t
print(a, b, c, t[1:], t + (4,), t * 2, t.index(2), t.count(3), len(t), (5,), tuple([1, 2]))
first, *rest = [1, 2, 3, 4]
*init, last = "abc"
x, (y, z) = 1, (2, 3)
print(first, rest, init, last, x, y, z)
a, b = b, a
print(a, b)
p = q = [0]
print(p is q)
for i, (k, v) in enumerate([("a", 1), ("b", 2)]):
    print(i, k, v)
try:
    m, n = [1, 2, 3]
except ValueError as e:
    print(e)
try:
    m, n, o = [1, 2]
except ValueError as e:
    print(e)
try:
    t[0] = 5
except TypeError as e:
    print(e)
''')

case("dicts", r'''
d = {"b": 1, "a": 2}
d["c"] = 3
d["b"] = 10
print(d, len(d), d["a"], d.get("z"), d.get("z", 0), "a" in d, list(d), list(d.keys()), list(d.values()), list(d.items()))
print(d.pop("a"), d, d.setdefault("e", 5), d.setdefault("e", 6), d)
d.update({"f": 1}, g=2)
d.update([("h", 3)])
print(d, d.copy() == d, {**d, "b": 0})
del d["b"]
print(d, d.popitem(), d)
for k, v in d.items():
    print(k, v)
mixed = {1: "int", True: "bool?", 1.0: "float?", (1, 2): "tuple", None: "none", "1": "str"}
print(mixed, mixed[(1, 2)], mixed[True])
print({k: v * 2 for k, v in {"x": 1, "y": 2}.items() if v > 1}, dict(a=1, b=2), dict([(1, 2)]), dict.fromkeys("ab", 0))
print({1: 2} | {3: 4}, sorted({"z": 1, "a": 2}), sorted({"z": 1, "a": 2}.items()))
try:
    d["missing"]
except KeyError as e:
    print("KeyError", e)
try:
    {}[[1]] = 2
except TypeError as e:
    print(e)
try:
    for key in d:
        d["new" + str(key)] = 1
except RuntimeError as e:
    print(e)
''')

case("sets", r'''
s = {3, 1, 2}
s.add(4)
s.add(1)
s.discard(10)
s.remove(3)
print(sorted(s), len(s), 2 in s, 3 in s)
a = {1, 2, 3}
b = {2, 3, 4}
print(sorted(a | b), sorted(a & b), sorted(a - b), sorted(a ^ b), a <= {1, 2, 3, 4}, a < a, a >= {1}, a.isdisjoint({9}))
print(sorted(a.union([7], (8,))), sorted(a.intersection(b)), sorted(a.difference(b)), a.issubset(range(5)))
c = set("hello")
print(sorted(c), len(c), sorted({x % 3 for x in range(10)}), set(), frozenset(), sorted(frozenset([1, 1, 2])))
fs = frozenset({1, 2})
lookup = {fs: "pair", frozenset(): "none"}
print(lookup[frozenset([2, 1])], fs == {1, 2}, hash(fs) == hash(frozenset([1, 2])))
a |= {9}
a -= {1}
print(sorted(a), set([1]) == {1})
try:
    s.remove(99)
except KeyError as e:
    print("KeyError", e)
print({(1, 2), (1, 2)}, {1, 1.0, True})
''')

case("dict_view_set_ops", r'''
d = {1: "a", 2: "b", 3: "c"}
e = {2: "b", 9: "z"}
k = d.keys()
s = {1, 4}
print(isinstance(s - k, set), isinstance(k & s, set), sorted(s - k), sorted(k - s), sorted(k & s), sorted(s & k), sorted(k | s), sorted(s | k))
print(sorted(k ^ s), sorted(s ^ k), sorted(k - e.keys()), sorted(k & e.keys()), sorted(k ^ e.keys()))
print(sorted([1, 5] - k), sorted(k - [1]), len(k | "xy"), "x" in (k | "x"), sorted(range(3) & k), isinstance(frozenset({1}) - k, set), isinstance(frozenset({1}) - k, frozenset))
print(sorted(d.items() - e.items()), sorted(d.items() & {(2, "b"), (2, "x")}), sorted(k - d.items()))
print(k == {1, 2, 3}, {1, 2, 3} == k, k != {1}, {1} != k, k == [1, 2, 3], k == e.keys(), d.items() == {(1, "a"), (2, "b"), (3, "c")})
print(k < {1, 2, 3, 4}, k <= {1, 2, 3}, k > {1}, k >= {1, 2, 3}, {1} < k, {1, 2, 3} <= k, {9} < k, k < k, {2: 0}.keys() <= k)
print(k.isdisjoint([7, 8]), k.isdisjoint({3}), d.items().isdisjoint([(1, "a")]))
t = {5}
t |= k
print(sorted(t), isinstance(t, set))
t -= e.keys()
print(sorted(t))
for bad in (lambda: d.values() - {1}, lambda: {1} - d.values(), lambda: k < [1], lambda: {1} < [1], lambda: d.values() == d.values()):
    try:
        print(bad())
    except TypeError as err:
        print("TypeError:", err)
try:
    u = {1}
    u |= [2]
except TypeError as err:
    print("TypeError:", err)
''')

case("ranges_iteration", r'''
print(list(range(3)), list(range(2, 8, 3)), list(range(5, 0, -2)), len(range(0, 10, 3)), range(10)[-1], range(1, 10, 2)[2])
print(list(enumerate("ab", 1)), list(zip([1, 2, 3], "ab")), list(reversed([1, 2, 3])), list(reversed(range(3))))
print(list(map(str, [1, 2])), list(filter(None, [0, 1, "", "x"])), list(map(lambda a, b: a + b, [1, 2], [10, 20])))
print(any([0, 0, 1]), all([1, 1, 0]), any([]), all([]), next(iter([5, 6])), next(iter([]), "empty"))
gen = (i * i for i in range(4))
print(next(gen), list(gen), sum(x for x in range(5) if x % 2), max(len(w) for w in ["a", "bbb"]))
it = iter([1, 2])
print(next(it), next(it), next(it, None))
print(range(0, 5), range(0, 6, 2), list(range(0)))
for i in range(3):
    if i == 1:
        continue
    print("loop", i)
else:
    print("no break")
for i in range(3):
    if i == 1:
        break
else:
    print("not printed")
n = 0
while n < 5:
    n += 1
    if n == 10:
        break
else:
    print("while else", n)
while True:
    n -= 1
    if n < 2:
        break
print(n)
''')

case("comprehensions", r'''
print([x * 2 for x in range(5) if x % 2 == 0], [(x, y) for x in range(3) for y in "ab" if x != 1])
print({x: x * x for x in range(3)}, sorted({c for c in "banana"}), [[y for y in range(x)] for x in range(3)])
fns = [lambda: i for i in range(3)]
print([f() for f in fns])
fns2 = [lambda i=i: i for i in range(3)]
print([f() for f in fns2])
x = "outer"
print([x for x in "ab"], x)
matrix = [[1, 2], [3, 4]]
print([v for row in matrix for v in row], [sum(row) for row in matrix], {k: [v for v in range(k)] for k in range(3)})
''')

case("functions", r'''
def f(a, b=2, *args, c, d=4, **kw):
    return (a, b, args, c, d, sorted(kw.items()))
print(f(1, c=3))
print(f(1, 5, 6, 7, c=3, e=5, d=0))
print(f(*[1, 2, 3], **{"c": 9, "z": 1}))
def g(x, y=[]):
    y.append(x)
    return y
print(g(1), g(2), g(3, []))
def kwonly(*, flag=False):
    return flag
print(kwonly(), kwonly(flag=True))
def pos(a, b, /, c):
    return a + b + c
print(pos(1, 2, c=3))
def outer():
    count = 0
    def inc():
        nonlocal count
        count += 1
        return count
    inc()
    inc()
    return inc()
print(outer())
total = 0
def add_total(n):
    global total
    total += n
add_total(5)
add_total(6)
print(total)
square = lambda v: v * v
print(square(5), (lambda *a, **k: (a, sorted(k)))(1, 2, x=3), sorted([3, 1, 2], key=lambda v: -v))
def rec(n):
    return 1 if n <= 1 else n * rec(n - 1)
print(rec(10))
def none_returner():
    pass
print(none_returner())
for call in (lambda: f(), lambda: f(1, 2, 3, c=1, b=2), lambda: kwonly(1), lambda: kwonly(nope=1), lambda: pos(1, b=2, c=3), lambda: g()):
    try:
        call()
    except TypeError as e:
        print("TypeError", e)
''')

case("classes", r'''
class Animal:
    kind = "animal"
    count = 0

    def __init__(self, name, sound="..."):
        self.name = name
        self.sound = sound
        Animal.count += 1

    def speak(self):
        return f"{self.name} says {self.sound}"

    def __repr__(self):
        return f"Animal({self.name!r})"

    @property
    def shout(self):
        return self.speak().upper()

    @staticmethod
    def helper(x):
        return x * 2

    @classmethod
    def make(cls, name):
        return cls(name, "hi")


class Dog(Animal):
    kind = "dog"

    def __init__(self, name):
        super().__init__(name, "woof")
        self.tricks = []

    def speak(self):
        return super().speak() + "!"


a = Animal("cat", "meow")
d = Dog("rex")
print(a.speak(), d.speak(), d.shout, a, [d], d.kind, a.kind, Animal.kind, Dog.helper(3), d.helper(4), Animal.count)
print(Dog.make("pup"), type(Dog.make("pup")) is Dog, isinstance(d, Animal), isinstance(a, Dog), issubclass(Dog, Animal))
bound = d.speak
print(bound(), bound == d.speak, str(a), f"{a}")
d.kind = "mine"
print(d.kind, Dog.kind, Animal("x").kind)
try:
    a.missing
except AttributeError as e:
    print("AttributeError", e)
try:
    Animal()
except TypeError as e:
    print("TypeError", e)
class Plain:
    pass
try:
    Plain(1)
except TypeError as e:
    print("TypeError", e)
print(getattr(a, "name"), getattr(a, "nope", "dflt"), hasattr(a, "name"), hasattr(a, "nope"))
setattr(a, "name", "tom")
print(a.name)
''')

case("dunders", r'''
class V:
    def __init__(self, x, y):
        self.x = x
        self.y = y
    def __add__(self, o):
        return V(self.x + o.x, self.y + o.y)
    def __sub__(self, o):
        return V(self.x - o.x, self.y - o.y)
    def __mul__(self, k):
        return V(self.x * k, self.y * k)
    def __rmul__(self, k):
        return self * k
    def __neg__(self):
        return V(-self.x, -self.y)
    def __eq__(self, o):
        return isinstance(o, V) and (self.x, self.y) == (o.x, o.y)
    def __hash__(self):
        return hash((self.x, self.y))
    def __lt__(self, o):
        return (self.x, self.y) < (o.x, o.y)
    def __len__(self):
        return 2
    def __getitem__(self, i):
        return (self.x, self.y)[i]
    def __contains__(self, v):
        return v in (self.x, self.y)
    def __repr__(self):
        return f"V({self.x}, {self.y})"
    def __str__(self):
        return f"<{self.x},{self.y}>"
a = V(1, 2)
b = V(3, 4)
print(a + b, b - a, a * 3, 2 * a, -a, a == V(1, 2), a != b, a < b, sorted([b, a]), len(a), a[1], 2 in a, list(a))
print(str(a), f"{a}", [a], {a: "first", V(1, 2): "same"}, max(a, b), V(1, 2) in [b, V(1, 2)])
acc = V(0, 0)
acc += a
print(acc)
class EqOnly:
    def __eq__(self, o):
        return True
try:
    {EqOnly(): 1}
except TypeError:
    print("TypeError unhashable")
try:
    V(1, 2) + 1
except AttributeError as e:
    print("AttributeError", e)
try:
    print(object() + 1)
except TypeError as e:
    print("TypeError", e)
''')

case("exceptions", r'''
class GameError(Exception):
    pass
class Detail(GameError):
    def __init__(self, code):
        super().__init__(f"code {code}")
        self.code = code
def risky(n):
    if n == 1:
        raise ValueError("bad value")
    if n == 2:
        raise Detail(7)
    if n == 3:
        return {}["k"]
    if n == 4:
        raise GameError
    return "fine"
for n in range(5):
    try:
        print(risky(n))
    except (KeyError, ValueError) as e:
        print("lookup/value", repr(e))
    except Detail as e:
        print("detail", e.code, e, e.args)
    except GameError as e:
        print("game", repr(e), str(e) == "")
    else:
        print("else ran")
    finally:
        print("finally", n)
def reraise():
    try:
        raise KeyError("x")
    except KeyError:
        raise
try:
    reraise()
except LookupError as e:
    print("reraised", repr(e), e)
try:
    try:
        1 / 0
    except ZeroDivisionError as e:
        raise RuntimeError("wrapped") from e
except RuntimeError as e:
    print(e)
def fin():
    try:
        return "try"
    finally:
        print("cleanup")
print(fin())
try:
    assert 1 == 2, "math broke"
except AssertionError as e:
    print("assert", e)
try:
    assert []
except AssertionError as e:
    print("assert empty", repr(e))
try:
    raise Exception("a", 1)
except Exception as e:
    print(e, e.args)
raise IndexError("uncaught at the end")
''')

case("enums_dataclasses", r'''
from dataclasses import dataclass, field, replace
from enum import Enum

class Color(Enum):
    RED = "red"
    GREEN = "green"

    @property
    def other(self):
        return Color.GREEN if self is Color.RED else Color.RED

    def shout(self):
        return self.value.upper()

print(Color.RED, repr(Color.RED), Color.RED.value, Color.RED.name, Color("green"), Color.RED.other, Color.GREEN.shout())
print(list(Color), len(Color), Color.RED in Color, Color["GREEN"], Color.RED == Color.RED, Color.RED == "red", f"{Color.RED}")
print({Color.RED: 1}[Color.RED], sorted(c.value for c in Color), isinstance(Color.RED, Color))
try:
    Color("blue")
except ValueError as e:
    print("ValueError", e)

@dataclass
class Point:
    x: int
    y: int = 0
    tags: list = field(default_factory=list)

    def moved(self, dx):
        return Point(self.x + dx, self.y)

@dataclass(frozen=True)
class Cell:
    col: int
    row: int

p = Point(1)
print(p, Point(1, 2) == Point(1, 2), Point(1) == Point(2), p.moved(5), p.tags, Point(3, tags=["a"]))
c = Cell(1, 2)
print(c, {c: "here"}[Cell(1, 2)], replace(c, row=5), c == Cell(1, 2), len({Cell(0, 0), Cell(0, 0)}))
try:
    Point()
except TypeError as e:
    print("TypeError", e)
try:
    hash(Point(1))
except TypeError as e:
    print("TypeError", e)
''')

case("stdlib_math_collections", r'''
import math
from collections import Counter, deque
from typing import NamedTuple

print(math.floor(2.7), math.ceil(2.1), math.floor(-2.5), math.sqrt(16), math.pi, math.isclose(0.1 + 0.2, 0.3), math.hypot(3, 4))
print(math.gcd(12, 18), math.factorial(5), math.trunc(-2.7), math.copysign(3, -1), math.degrees(math.pi), math.inf > 1e308)
print(round(math.sin(math.pi / 2), 6), round(math.atan2(1, 1), 6), math.fabs(-2), math.log(math.e), math.log(8, 2))
try:
    math.sqrt(-1)
except ValueError as e:
    print("ValueError", e)
q = deque([1, 2])
q.append(3)
q.appendleft(0)
print(q, q.popleft(), q.pop(), len(q), list(q), 2 in q)
cnt = Counter("abracadabra")
print(cnt.most_common(2), cnt["a"], cnt["z"], len(cnt))

class Quote(NamedTuple):
    price: int
    items: list

qt = Quote(price=5, items=[1])
print(qt, qt.price, qt[0], qt == (5, [1]), tuple(qt), len(qt))
''')

case("isinstance_type", r'''
print(isinstance(1, int), isinstance(True, int), isinstance("a", str), isinstance([], list), isinstance((), tuple))
print(isinstance({}, dict), isinstance(set(), set), isinstance(1, (str, int)), isinstance(None, int), isinstance(2.5, float))
print(type(1) is int, type("a") is str, type([]) is list, type({}) is dict, callable(len), callable(1))
print(int, str, list, repr(len) == repr(len))
''')

case("tasks", r'''
from helpers import wait

async def sub(n):
    got = await wait(n)
    return f"sub got {got}"

async def main():
    first = await wait("hello")
    print("first", first)
    result = await sub(2)
    print(result)
    for i in range(2):
        await wait(i)
    return "done"
''')

case("closures_scoping", r'''
def make_counter():
    counts = {"n": 0}
    def bump(by=1):
        counts["n"] += by
        return counts["n"]
    return bump
c = make_counter()
c()
print(c(5))
def shadow():
    len = 3
    return len
print(shadow(), len("abc"))
x = 1
def reads_global():
    return x + 1
print(reads_global())
items = []
for i in range(3):
    items.append(lambda: i)
print([f() for f in items])
def walrus(values):
    if (n := len(values)) > 2:
        return n
    return -n
print(walrus([1, 2, 3]), walrus([1]))
''')

case("print_options", r'''
print("a", "b", sep="-", end="!\n")
print()
print("no newline", end="")
print(" continued")
print(*[1, 2, 3], sep=", ")
print(0.1 * 3, 2 / 3, 10 / 2)
''')

case("chained_ops_and_slices", r'''
xs = list(range(10))
print(xs[2:8:2], xs[-1:-5:-1], xs[::3], xs[8:2:-3], xs[:-7], "hello"[1:-1])
xs[::2] = [0] * 5
print(xs)
try:
    xs[::2] = [1]
except ValueError as e:
    print(e)
print(1 < 2 <= 2 < 3 != 4, 3 > 2 > 2, 0 <= 5 < 10)
a = b = c = 5
print(a, b, c)
nums = [1, 2, 3]
nums[0] += 10
d = {"k": 1}
d["k"] *= 7
print(nums, d)
''')

case("decorators_properties", r'''
calls = []

def logged(fn):
    def wrapper(*args, **kwargs):
        calls.append("call")
        return fn(*args, **kwargs)
    return wrapper

def tag(label):
    def deco(cls):
        cls.label = label
        return cls
    return deco

@logged
def add(a, b=1):
    return a + b

@tag("tagged")
class Box:
    SIZE = 2
    DOUBLE = SIZE * 2
    names = [n for n in ("a", "b")]

    def __init__(self, w):
        self._w = w

    @property
    def width(self):
        return self._w

    @width.setter
    def width(self, value):
        self._w = max(0, value)

    @logged
    def area(self):
        return self._w * self.SIZE

b = Box(3)
b.width = -5
print(add(1), add(2, b=5), len(calls), Box.label, b.label, Box.DOUBLE, Box.names, b.width, b.area(), len(calls))
b.width = 4
print(b.width, b.area())

class Registry:
    seen = []
    def __init_subclass__(cls):
        Registry.seen.append(cls.KIND)

class A(Registry):
    KIND = "a"

class B(A):
    KIND = "b"

print(Registry.seen)
''')

case("defaults_and_globals", r'''
LIMIT = 3
SCALE = LIMIT * 2.5
NAMES = ("x", "y")
Pair = tuple[int | None, ...]

def clamp(v, lo=0, hi=LIMIT):
    return lo if v < lo else hi if v > hi else v

LIMIT = 100
print(clamp(5), clamp(-1), clamp(50, hi=LIMIT), SCALE, NAMES)

def collect(item, bucket=[]):
    bucket.append(item)
    return len(bucket)

print(collect(1), collect(2), collect(3, []))
counter = {"n": 0}

def bump():
    counter["n"] += 1
    return counter["n"]

values = [bump() for _ in range(3)]
print(values, counter)
''')

case("unicode_and_text", r'''
s = "🎮 go!"
print(len(s), s[0], s[2:], s[::-1], list("é🎮"), "🎮" in s, s.find("g"), s.upper(), repr("🎮​"))
print(sorted(["b", "A", "a", "é", "🎮"]), "a🎮b".split("🎮"), "x".join("🎮🎮"), "🎮".center(5, "*"))
print(f"{'🎮':>4}|", f"{s!r}")
''')

case("generators_lazy", r'''
log = []
def track(v):
    log.append(v)
    return v
gen = (track(v) for v in range(5))
print(log)
print(next(gen), log)
print(any(track(v) > 1 for v in range(10)), log)
print(list(zip(range(3), (track(x) for x in "abcdef"))), log[-3:])
items = {"b": 2, "a": 1}
print(sorted(items, key=lambda k: items[k]), min(items.items(), key=lambda kv: kv[1]))
pairs = [(1, "x"), (0, "y"), (1, "a"), (0, "b")]
print(sorted(pairs, key=lambda p: p[0]), sorted(pairs, key=lambda p: p[0], reverse=True))
''')

case("loops_and_control", r'''
found = None
for row in range(3):
    for col in range(3):
        if row * col == 2:
            found = (row, col)
            break
    else:
        continue
    break
print(found)
i = 0
results = []
while i < 10:
    i += 1
    try:
        if i % 3 == 0:
            raise ValueError(i)
        if i == 8:
            break
        results.append(i)
    except ValueError as e:
        results.append(f"err{e}")
        continue
    finally:
        results.append("f")
print(results)
total = 0
for a, b in [(1, 2), (3, 4)]:
    total += a * b
print(total, [x for x in range(20) if x % 2 if x % 3])
''')

case("numbers_more", r'''
print(10 / 4, 9 / 3, -9 // 4, 2 ** 0.5, 0.1 + 0.7, 1.1 * 3, 1e-7 * 1, 123456.789e3, 5e-324, 1.7976931348623157e308)
print(int(2.5e3), int(-0.9), abs(-0.5), round(-0.5), round(1.25, 1), round(1.35, 1), round(2.5e-3, 3))
print(max(1, 2.5), min(-1, -1.5), sorted([3, 1.5, 2]), 7 // 2.0, 7 % 2.5, (-7) % 2.5)
print(f"{1/3:.3f} {2/3:.1%} {1e6:,.2f} {1234.5678:.2e} {0.000123:.2g} {1e20:.3g} {100:.2f}")
x = 5
x //= 2
x **= 3
x -= 1
x %= 5
x <<= 2
print(x, 1_000_000, 0x1F, 0o17, 0b101, hex(255), bin(5), oct(8))
''')
