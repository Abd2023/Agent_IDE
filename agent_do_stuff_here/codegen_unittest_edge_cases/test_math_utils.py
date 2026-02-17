import unittest
import math_utils

class MathUtilsEdgeCases(unittest.TestCase):
    def test_add_zero(self):
        self.assertEqual(math_utils.add(0, 0), 0)

    def test_add_negative(self):
        self.assertEqual(math_utils.add(-5, -3), -8)

    def test_div_positive(self):
        self.assertEqual(math_utils.div(10, 2), 5)

    def test_div_float(self):
        self.assertAlmostEqual(math_utils.div(7, 2), 3.5)

    def test_div_by_zero_raises(self):
        with self.assertRaises(ValueError):
            math_utils.div(3, 0)

if __name__ == "__main__":
    unittest.main()
