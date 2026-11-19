import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "sync-upstream.yml"


class SyncUpstreamWorkflow(unittest.TestCase):
    def test_does_not_depend_on_github_issues(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("gh issue", text)
        self.assertNotIn("issues: write", text)
        self.assertIn("GITHUB_STEP_SUMMARY", text)
        self.assertIn("gh pr create", text)
        self.assertIn("gh pr comment", text)


if __name__ == "__main__":
    unittest.main()
