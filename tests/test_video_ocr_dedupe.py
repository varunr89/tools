import sys
import types
import unittest


# Provide lightweight stubs so video_ocr can import in non-macOS test envs.
if "Vision" not in sys.modules:
    sys.modules["Vision"] = types.ModuleType("Vision")
if "Cocoa" not in sys.modules:
    cocoa_stub = types.ModuleType("Cocoa")

    class _DummyNSURL:
        @classmethod
        def fileURLWithPath_(cls, path):
            return path

    cocoa_stub.NSURL = _DummyNSURL
    sys.modules["Cocoa"] = cocoa_stub

import video_ocr


class TestDedupeLogic(unittest.TestCase):
    def test_should_keep_function_exists(self):
        if not hasattr(video_ocr, "should_keep"):
            self.fail("Expected video_ocr.should_keep to exist")

    def test_should_keep_first_frame(self):
        if not hasattr(video_ocr, "should_keep"):
            self.fail("Expected video_ocr.should_keep to exist")
        self.assertTrue(video_ocr.should_keep(None, 0b0000, max_diff_ratio=0.25, hash_bits=4))

    def test_should_skip_similar_frame(self):
        if not hasattr(video_ocr, "should_keep"):
            self.fail("Expected video_ocr.should_keep to exist")
        # Hamming distance 1/4 = 0.25 -> similar at threshold 0.25
        self.assertFalse(video_ocr.should_keep(0b0000, 0b0001, max_diff_ratio=0.25, hash_bits=4))

    def test_should_keep_different_frame(self):
        if not hasattr(video_ocr, "should_keep"):
            self.fail("Expected video_ocr.should_keep to exist")
        # Hamming distance 1/4 = 0.25 -> different when threshold is below
        self.assertTrue(video_ocr.should_keep(0b0000, 0b0001, max_diff_ratio=0.24, hash_bits=4))


if __name__ == "__main__":
    unittest.main()
