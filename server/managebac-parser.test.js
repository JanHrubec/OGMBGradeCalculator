import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateFinalGrade,
  calculatePercentage,
  parseAuthenticityToken,
  parseClassData,
  parseClasses
} from './managebac-parser.js';

test('finds the login token regardless of attribute order', () => {
  const html = `<form action='/sessions'><input value='token-value' type='hidden' name='authenticity_token'></form>`;
  assert.equal(parseAuthenticityToken(html), 'token-value');
});

test('parses class cards without depending on attribute quote style or order', () => {
  const html = `
    <div class="accordion" id="ib_class_42">
      <a data-extra="yes" href="/student/classes/42" class="title"> Biology &amp; Chemistry </a>
    </div>`;

  assert.deepEqual(parseClasses(html), [{ id: '42', name: 'Biology & Chemistry' }]);
});

test('parses categories and graded tasks from the current ManageBac card layout', () => {
  const html = `
    <div class="short-assignment section f-tile f-tile--inline">
      <div class="date-badge"><div class="month">Oct</div><div class="day">7</div></div>
      <a href="/student/classes/42/core_tasks/99"> Lab report </a>
      <div class="labels-set">
        <div style="--f-label-bg:#478cfe" class="label">Summative</div>
        <div style="color:white; --f-label-bg: #33C" class="label"> Labs </div>
      </div>
      <div class="assessment"><span class="grade">6</span><div class="points">7,5 / 10 pts</div></div>
    </div>
    <div id="categories-table">
      <div class="list-item"><div class="label" style="--f-label-bg: #33C">Labs</div><div>40%</div></div>
      <div class="list-item"><div class="label" style="--f-label-bg: #abc">Exams</div><div>60%</div></div>
    </div>`;

  const result = parseClassData(html, '42');
  assert.equal(result.categories.length, 2);
  assert.deepEqual(result.tasks[0], {
    id: '42:99',
    taskId: '99',
    classId: '42',
    name: 'Lab report',
    date: 'Oct 7',
    category: 'Labs',
    categoryColor: '#33C',
    points: '7,5 / 10 pts',
    grade: '6',
    percentage: 75
  });
});

test('falls back to task-link metadata when ManageBac changes card classes', () => {
  const html = `
    <div class="unknown-card"><div class="content">
      <div class="date-badge"><div class="month">Nov</div><div class="day">2</div></div>
      <a href="/student/classes/9/core_tasks/7">Unclassified card</a>
      <div class="labels-set"><div class="label">Summative</div><div class="label">Coursework</div></div>
      <div class="assessment"><div class="points">15 / 20 pts</div></div>
    </div></div>`;

  const result = parseClassData(html, '9');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].name, 'Unclassified card');
  assert.equal(result.tasks[0].percentage, 75);
  assert.equal(result.tasks[0].category, 'Coursework');
});

test('keeps category groups visible if ManageBac moves the weights again', () => {
  const html = `
    <div class="fusion-card-item short-assignment">
      <a href="/student/classes/1/core_tasks/2">Essay</a>
      <div class="label">Summative</div><div class="label" style="--f-label-bg:#123456">Writing</div>
      <div class="points">9 / 10 pts</div>
    </div>`;

  const result = parseClassData(html, '1');
  assert.deepEqual(result.categories, [{ name: 'Writing', weight: 0, color: '#123456' }]);
  assert.equal(result.tasks[0].percentage, 90);
});

test('calculates weighted grades using normalized category names and unrounded scores', () => {
  const categories = [
    { name: ' Course Work ', weight: 40 },
    { name: 'Exam', weight: 60 }
  ];
  const tasks = [
    { category: 'course   work', percentage: calculatePercentage('2 / 3 pts') },
    { category: 'EXAM', percentage: 80 }
  ];

  assert.equal(calculateFinalGrade(tasks, categories), 75);
});
