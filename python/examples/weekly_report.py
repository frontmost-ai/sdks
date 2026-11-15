"""Print this week's numbers for one project, the rivals that AI apps name instead of you,
and the answers that cite reddit.com but do not name you.

    FRONTMOST_API_KEY=fmk_... python examples/weekly_report.py 90
"""

import sys

from frontmost import Frontmost, format_rate

project_id = sys.argv[1] if len(sys.argv) > 1 else "90"
client = Frontmost()

metrics = client.metrics.get(project_id, period="week", compare_to="previous")
totals = metrics["totals"]
if totals is None:
    print(metrics.get("message"))
    sys.exit(0)
print(f"Visibility  {format_rate(totals['visibility'])}")
print(f"Win rate    {format_rate(totals['win_rate'])}")

rivals = client.rivals.list(project_id, period="week").to_list()
rivals.sort(key=lambda rival: rival["named_instead_of_you"], reverse=True)
for rival in rivals[:3]:
    print(f"{rival['name']} was named instead of you in {rival['named_instead_of_you']} answers")

for answer in client.answers.list(project_id, cited_domain="reddit.com", named=False, limit=5):
    print(f"{answer['app']}: {answer['question']['text']}")
