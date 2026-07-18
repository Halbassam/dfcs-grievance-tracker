// Self-test: contractData.js relevance search — no network, no DB.
// Verifies the contract/MOU JSON loads and that keyword search returns
// sensible, on-topic results for a few representative grievance scenarios.
const assert = require('assert');
const contractData = require('../server/contractData');

let checks = 0;
function check(label, cond){
  checks++;
  if(!cond){ console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`ok - ${label}`);
}

const titles = contractData.listArticleTitles();
check('parses all 35 articles', titles.length === 35);
check('includes Article V — Grievance Procedure', titles.some(t => t.startsWith('Article V —')));
check('includes Article IX — Discipline', titles.some(t => t.startsWith('Article IX —')));

const disciplineResults = contractData.searchRelevant(
  'My grievant got a written warning for tardiness with no verbal counseling first, progressive discipline was skipped',
  7
);
const disciplineLabels = disciplineResults.map(r => r.label);
check('Article V always included', disciplineLabels.some(l => l.startsWith('Article V —')));
check('discipline scenario surfaces Article IX (Discipline)', disciplineLabels.some(l => l.startsWith('Article IX —')));
check('returns no more than 7 chunks', disciplineResults.length <= 7);

const overtimeResults = contractData.searchRelevant(
  'forced mandatory overtime with no advance notice, seniority order not followed',
  7
);
const overtimeLabels = overtimeResults.map(r => r.label);
check('overtime scenario surfaces Article XII (Hours of Work and Overtime)', overtimeLabels.some(l => l.startsWith('Article XII —')));
check('overtime scenario surfaces a mandatory-overtime MOU', overtimeLabels.some(l => /overtime/i.test(l)));

const vacancyResults = contractData.searchRelevant(
  'a permanent vacancy was filled by someone with less seniority than my grievant, bypassing the posting process',
  7
);
const vacancyLabels = vacancyResults.map(r => r.label);
check('vacancy scenario surfaces Article XIX (Filling of Vacancies)', vacancyLabels.some(l => l.startsWith('Article XIX —')));

console.log(`\n${checks} checks run.`);
if (process.exitCode) {
  console.error('SELF-TEST FAILED');
} else {
  console.log('ALL SELF-TESTS PASSED');
}
