"""Tests for PomodoroSession phase transitions and sound mapping."""

import unittest
from pomodoro.pomodoro import PomodoroSession


class TestPomodoroSessionAdvance(unittest.TestCase):
    """Test the WORK -> BREAK -> WORK state machine."""

    def test_starts_in_work_phase(self):
        s = PomodoroSession(25, 5, 15, 4)
        self.assertEqual(s.phase, s.WORK)
        self.assertEqual(s.current_session, 1)
        self.assertFalse(s.is_complete())

    def test_work_to_short_break(self):
        s = PomodoroSession(25, 5, 15, 4)
        s.advance()  # session 1 work -> short break
        self.assertEqual(s.phase, s.SHORT_BREAK)

    def test_short_break_to_work(self):
        s = PomodoroSession(25, 5, 15, 4)
        s.advance()  # work -> short break
        s.advance()  # short break -> work (session 2)
        self.assertEqual(s.phase, s.WORK)
        self.assertEqual(s.current_session, 2)

    def test_long_break_after_4th_session(self):
        s = PomodoroSession(25, 5, 15, 8)
        # Advance through 4 work+break cycles
        for _ in range(3):
            s.advance()  # work -> short break
            s.advance()  # short break -> work
        # Now on session 4, advance from work
        s.advance()
        self.assertEqual(s.phase, s.LONG_BREAK)

    def test_final_session_sets_done(self):
        s = PomodoroSession(25, 5, 15, 2)
        s.advance()  # session 1 work -> short break
        s.advance()  # short break -> session 2 work
        result = s.advance()  # session 2 work -> done
        self.assertFalse(result)
        self.assertTrue(s.is_complete())

    def test_single_session_completes_immediately(self):
        s = PomodoroSession(25, 5, 15, 1)
        result = s.advance()  # only session -> done
        self.assertFalse(result)
        self.assertTrue(s.is_complete())

    def test_no_trailing_break(self):
        """Final work session ends the cycle -- no break after it."""
        s = PomodoroSession(25, 5, 15, 1)
        s.advance()
        self.assertTrue(s.is_complete())
        # Phase should still be WORK (advance doesn't change it on completion)
        self.assertEqual(s.phase, s.WORK)


class TestSoundForCompletedPhase(unittest.TestCase):
    """Test sound selection for completed phases."""

    def test_work_done_sound(self):
        s = PomodoroSession(25, 5, 15, 4)
        self.assertEqual(s.sound_for_completed_phase(s.WORK), "work_done")

    def test_break_done_sound(self):
        s = PomodoroSession(25, 5, 15, 4)
        self.assertEqual(s.sound_for_completed_phase(s.SHORT_BREAK), "break_done")

    def test_long_break_done_sound(self):
        s = PomodoroSession(25, 5, 15, 4)
        self.assertEqual(s.sound_for_completed_phase(s.LONG_BREAK), "break_done")

    def test_all_done_on_final_work_session(self):
        s = PomodoroSession(25, 5, 15, 1)
        # Before advance -- should still detect final session
        self.assertEqual(s.sound_for_completed_phase(s.WORK), "all_done")

    def test_all_done_after_advance(self):
        s = PomodoroSession(25, 5, 15, 1)
        s.advance()  # sets _done
        self.assertEqual(s.sound_for_completed_phase(s.WORK), "all_done")

    def test_not_all_done_on_non_final_session(self):
        s = PomodoroSession(25, 5, 15, 4)
        self.assertEqual(s.sound_for_completed_phase(s.WORK), "work_done")

    def test_order_independence(self):
        """sound_for_completed_phase works before or after advance()."""
        # Before advance
        s1 = PomodoroSession(25, 5, 15, 2)
        s1.advance()  # work -> break
        s1.advance()  # break -> session 2 work
        sound_before = s1.sound_for_completed_phase(s1.WORK)

        # After advance
        s2 = PomodoroSession(25, 5, 15, 2)
        s2.advance()
        s2.advance()
        s2.advance()  # session 2 work -> done
        sound_after = s2.sound_for_completed_phase(s2.WORK)

        self.assertEqual(sound_before, "all_done")
        self.assertEqual(sound_after, "all_done")


if __name__ == "__main__":
    unittest.main()
