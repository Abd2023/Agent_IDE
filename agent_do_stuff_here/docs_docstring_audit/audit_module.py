def long_calc(a, b):
    """Performs audited long calculation logic."""
    x = a + b
    y = a - b
    z = a * b
    if b != 0:
        q = a / b
    else:
        q = 0
    r = x + y + z + q
    r += 1
    r += 2
    r += 3
    return r
