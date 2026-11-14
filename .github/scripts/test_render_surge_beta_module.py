import unittest
from pathlib import Path

from render_surge_beta_module import (
    DEFAULT_PUBLIC_REPO, assert_expected_diff, parse_module_arguments, render,
)

ROOT = Path(__file__).resolve().parents[2]


class ModuleArguments(unittest.TestCase):
    def test_optional_defaults_and_quoted_commas(self):
        self.assertEqual(parse_module_arguments('#!arguments=cron,subs,cors:"https://a,https://b",timeout:900'),
                         {'cron': '', 'subs': '', 'cors': 'https://a,https://b', 'timeout': '900'})

    def test_rejects_screenshot_regression_and_following_empty_fields(self):
        for field in ('prefetch_cron:', 'prefetch_sub:', 'prefetch_col:', 'prefetch_cron:   '):
            with self.subTest(field=field), self.assertRaises(SystemExit):
                parse_module_arguments('#!arguments=' + field)

    def test_rejects_duplicates_and_unbalanced_quotes(self):
        for header in ('a:1,a:2', 'a:"x', 'a:1,,b:2'):
            with self.subTest(header=header), self.assertRaises(SystemExit):
                parse_module_arguments('#!arguments=' + header)

    def test_real_published_module_defaults_and_roundtrip(self):
        source = (ROOT / 'config/Surge-Beta.sgmodule').read_bytes()
        updated = render(source, DEFAULT_PUBLIC_REPO)
        defaults = parse_module_arguments(updated.decode())
        self.assertEqual(defaults['prefetch_cron'], '50 */6 * * *')
        for name in ('prefetch_sub', 'prefetch_col'):
            self.assertEqual(defaults[name], 'off')
        for name in ('sync', 'produce', 'prefetch'):
            self.assertTrue(defaults[name].startswith('#'))
        self.assertTrue(all(defaults.values()), 'No required module fields without defaults')
        self.assertTrue(defaults['prefetch'].startswith('#'))
        self.assertIn('https://ahuai6.github.io', defaults['cors'])
        self.assertIn(
            b'https://github.com/ahuai6/Sub-Store-Fork/releases/latest/download/',
            updated,
        )
        assert_expected_diff(source, updated, DEFAULT_PUBLIC_REPO)

    def test_committed_module_matches_renderer(self):
        source = (ROOT / 'config/Surge-Beta.sgmodule').read_bytes()
        updated = render(source, DEFAULT_PUBLIC_REPO)
        committed = (ROOT / 'dist' / 'Surge-Beta.sgmodule').read_bytes()
        self.assertEqual(committed, updated)

    def test_check_rejects_any_default_active_schedule(self):
        source = (ROOT / 'config/Surge-Beta.sgmodule').read_bytes()
        updated = render(source, DEFAULT_PUBLIC_REPO)
        for task in ('sync', 'produce', 'prefetch'):
            with self.subTest(task=task), self.assertRaises(SystemExit):
                broken = updated.replace((task + ':"# Sub-Store').encode(),
                                         (task + ':"Sub-Store').encode())
                assert_expected_diff(source, broken, DEFAULT_PUBLIC_REPO)

    def test_check_rejects_old_header_even_when_cron_is_commented_out(self):
        source = (ROOT / 'config/Surge-Beta.sgmodule').read_bytes()
        updated = render(source, DEFAULT_PUBLIC_REPO).replace(b',prefetch_cron:"50 */6 * * *",', b',prefetch_cron:,')
        with self.assertRaises(SystemExit):
            assert_expected_diff(source, updated, DEFAULT_PUBLIC_REPO)


if __name__ == '__main__':
    unittest.main()
