import { load } from 'cheerio';

export function normalizeText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function categoryKey(value = '') {
  return normalizeText(value).normalize('NFKC').toLocaleLowerCase('en');
}

function extractColor(style = '') {
  const match = style.match(/--f-label-bg\s*:\s*(#[\da-f]{3,8})/i);
  return match?.[1] || '#f97316';
}

export function calculatePercentage(pointsText) {
  const normalized = normalizeText(pointsText).replace(/,/g, '.');
  const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*(?:\/|of)\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;

  const earned = Number.parseFloat(match[1]);
  const total = Number.parseFloat(match[2]);
  return Number.isFinite(earned) && Number.isFinite(total) && total > 0
    ? (earned / total) * 100
    : null;
}

export function parseAuthenticityToken(html) {
  const $ = load(html);
  return $('input[name="authenticity_token"]').first().attr('value') || null;
}

export function parseClasses(html) {
  const $ = load(html);
  const classes = new Map();

  $('[id^="ib_class_"]').each((_, element) => {
    const idFromContainer = ($(element).attr('id') || '').match(/^ib_class_(\d+)$/)?.[1];
    const link = $(element).find('a[href*="/student/classes/"]').filter((__, anchor) => {
      return ($(anchor).attr('href') || '').match(/^\/student\/classes\/(\d+)\/?(?:[?#].*)?$/);
    }).first();
    const id = (link.attr('href') || '').match(/^\/student\/classes\/(\d+)/)?.[1] || idFromContainer;
    const name = normalizeText(link.text());
    if (id && name) classes.set(id, { id, name });
  });

  // A link-based fallback keeps this working if ManageBac removes some or all accordion IDs.
  $('a[href*="/student/classes/"]').each((_, element) => {
    const id = ($(element).attr('href') || '').match(/^\/student\/classes\/(\d+)\/?(?:[?#].*)?$/)?.[1];
    const name = normalizeText($(element).text());
    if (id && name && !classes.has(id)) classes.set(id, { id, name });
  });

  return [...classes.values()];
}

export function parseCategories(html) {
  const $ = load(html);
  const categories = new Map();
  const categoryContainers = $('#categories-table, [data-testid*="categor" i], [aria-label*="categor" i]');
  let rows = categoryContainers.find('.list-item, tr');
  if (!rows.length) rows = $('.list-item, tr');

  rows.each((_, element) => {
    const label = $(element).find('.label').first();
    const name = normalizeText(label.text());
    const weightMatch = normalizeText($(element).text()).match(/(-?\d+(?:[.,]\d+)?)\s*%/);
    if (!name || !weightMatch) return;

    const weight = Number.parseFloat(weightMatch[1].replace(',', '.'));
    if (!Number.isFinite(weight)) return;
    categories.set(categoryKey(name), {
      name,
      weight,
      color: extractColor(label.attr('style'))
    });
  });

  return [...categories.values()];
}

function findTaskCategory($, element, knownCategories) {
  const labels = $(element).find('.labels-set .label, .label').toArray().map(label => ({
    name: normalizeText($(label).text()),
    color: extractColor($(label).attr('style'))
  })).filter(label => label.name);

  const exactMatch = labels.find(label => knownCategories.has(categoryKey(label.name)));
  if (exactMatch) return exactMatch;

  const assignmentTypes = new Set(['formative', 'summative']);
  return [...labels].reverse().find(label => !assignmentTypes.has(categoryKey(label.name))) || null;
}

export function parseTasks(html, requestedClassId, categories = parseCategories(html)) {
  const $ = load(html);
  const knownCategories = new Set(categories.map(category => categoryKey(category.name)));
  const tasks = [];

  const taskContainers = new Set();
  $('a[href*="/core_tasks/"]').each((_, link) => {
    if (!/\/student\/classes\/\d+\/core_tasks\/\d+/.test($(link).attr('href') || '')) return;
    const container = $(link).closest('.fusion-card-item, [data-testid*="task-card" i], article, li').get(0);
    if (container) taskContainers.add(container);
  });

  for (const element of taskContainers) {
    const link = $(element).find('a[href*="/core_tasks/"]').filter((__, anchor) => {
      return /\/student\/classes\/\d+\/core_tasks\/\d+/.test($(anchor).attr('href') || '');
    }).first();
    const hrefMatch = (link.attr('href') || '').match(/\/student\/classes\/(\d+)\/core_tasks\/(\d+)/);
    if (!hrefMatch) continue;

    const classId = hrefMatch[1] || String(requestedClassId);
    const taskId = hrefMatch[2];
    const name = normalizeText(link.text());
    if (!name) continue;

    const month = normalizeText($(element).find('.date-badge .month, .month').first().text());
    const day = normalizeText($(element).find('.date-badge .day, .day').first().text());
    const category = findTaskCategory($, element, knownCategories);
    const points = normalizeText($(element).find('.assessment .points, .points').first().text()) || null;
    const grade = normalizeText($(element).find('.assessment .grade, .grade').first().text()) || null;

    tasks.push({
      id: `${classId}:${taskId}`,
      taskId,
      classId,
      name,
      date: month && day ? `${month} ${day}` : null,
      category: category?.name || null,
      categoryColor: category?.color || null,
      points,
      grade,
      percentage: calculatePercentage(points)
    });
  }

  return tasks;
}

export function parseClassData(html, classId) {
  const categories = parseCategories(html);
  const tasks = parseTasks(html, classId, categories);
  const knownCategories = new Set(categories.map(category => categoryKey(category.name)));

  // If weights disappear from a future ManageBac layout, still expose task groups in the UI.
  for (const task of tasks) {
    const key = categoryKey(task.category);
    if (!key || knownCategories.has(key)) continue;
    categories.push({ name: task.category, weight: 0, color: task.categoryColor || '#f97316' });
    knownCategories.add(key);
  }

  return { categories, tasks };
}

export function calculateFinalGrade(tasks, categories) {
  if (!categories.length || !tasks.length) return null;

  const categoryAverages = new Map();
  for (const task of tasks) {
    const key = categoryKey(task.category);
    if (!key || !Number.isFinite(task.percentage)) continue;
    const values = categoryAverages.get(key) || [];
    values.push(task.percentage);
    categoryAverages.set(key, values);
  }

  let totalWeightedScore = 0;
  let totalWeight = 0;
  for (const category of categories) {
    const values = categoryAverages.get(categoryKey(category.name));
    if (!(category.weight > 0) || !values?.length) continue;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    totalWeightedScore += average * category.weight;
    totalWeight += category.weight;
  }

  return totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : null;
}

export function assertManageBacPage(html) {
  const text = String(html || '');
  if (/denied access to the page/i.test(text)) {
    throw new Error('ManageBac denied access to this class');
  }
  const $ = load(text);
  if ($('form[action*="/sessions"] input[name="authenticity_token"]').length) {
    throw new Error('ManageBac session expired');
  }
}
