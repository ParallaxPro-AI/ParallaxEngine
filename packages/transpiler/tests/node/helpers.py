"""CPython twin of helpers.js: `await wait(x)` yields x to the driver."""
import types


@types.coroutine
def wait(value):
    return (yield value)
