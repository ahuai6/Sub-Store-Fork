import tempfile
import unittest
from pathlib import Path

from check_geo_upstream import (
    DEFAULT_NOTICE,
    append_summary,
    evaluate_drift,
    extract_recorded_blob_sha,
)

ROOT = Path(__file__).resolve().parents[2]


class CheckGeoUpstreamTests(unittest.TestCase):
    def test_extracts_blob_sha_from_committed_geo_notice(self):
        notice = (ROOT / DEFAULT_NOTICE).read_text(encoding="utf-8")
        sha = extract_recorded_blob_sha(notice)
        self.assertEqual(sha, "1d573206451a140b3ba3964b07f7de392e7e5ccd")

    def test_evaluate_drift_reports_unchanged_when_shas_match(self):
        sha = "1d573206451a140b3ba3964b07f7de392e7e5ccd"
        drifted, message = evaluate_drift(
            sha, {"sha": sha, "html_url": "https://example.invalid/geo.js"}
        )
        self.assertFalse(drifted)
        self.assertIn("unchanged", message)

    def test_evaluate_drift_formats_summary_when_upstream_changes(self):
        old_sha = "1d573206451a140b3ba3964b07f7de392e7e5ccd"
        new_sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        drifted, report = evaluate_drift(
            old_sha,
            {"sha": new_sha, "html_url": "https://github.com/xream/scripts/blob/main/surge/modules/sub-store-scripts/check/geo.js"},
        )
        self.assertTrue(drifted)
        self.assertIn(old_sha, report)
        self.assertIn(new_sha, report)
        self.assertIn("GEO-NOTICE.md", report)

        with tempfile.TemporaryDirectory() as tmp:
            summary = Path(tmp) / "summary.md"
            append_summary(summary, report)
            self.assertIn("geo.js upstream drift detected", summary.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
