import unittest

from dist_source_sha import published_source_sha

SHA = "0123456789abcdef0123456789abcdef01234567"


class PublishedSourceSha(unittest.TestCase):
    def test_reads_the_release_table_row(self):
        text = f"| Version | `2.44.11` |\n| Built from | `{SHA}` |\n"
        self.assertEqual(published_source_sha(text), SHA)

    def test_rejects_a_missing_or_duplicate_row(self):
        with self.assertRaises(ValueError):
            published_source_sha("no built-from row\n")
        duplicated = (
            f"| Built from | `{SHA}` |\n| Built from | `{SHA}` |\n"
        )
        with self.assertRaises(ValueError):
            published_source_sha(duplicated)


if __name__ == "__main__":
    unittest.main()
