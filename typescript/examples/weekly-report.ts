// Print this week's numbers for one project, the rivals that AI apps name instead of you,
// and the answers that cite reddit.com but do not name you.
//
//   FRONTMOST_API_KEY=fmk_... npx tsx examples/weekly-report.ts 90

import Frontmost, { formatRate } from "@frontmost-ai/sdk";

const projectId = process.argv[2] ?? "90";
const client = new Frontmost();

const metrics = await client.metrics.get(projectId, { period: "week", compare_to: "previous" });
if (!metrics.totals) {
  console.log(metrics.message);
  process.exit(0);
}
console.log(`Visibility  ${formatRate(metrics.totals.visibility)}`);
console.log(`Win rate    ${formatRate(metrics.totals.win_rate)}`);

const rivals = await client.rivals.list(projectId, { period: "week" }).toArray();
rivals.sort((a, b) => b.named_instead_of_you - a.named_instead_of_you);
for (const rival of rivals.slice(0, 3)) {
  console.log(`${rival.name} was named instead of you in ${rival.named_instead_of_you} answers`);
}

for await (const answer of client.answers.list(projectId, { cited_domain: "reddit.com", named: false, limit: 5 })) {
  console.log(`${answer.app}: ${answer.question.text}`);
}
