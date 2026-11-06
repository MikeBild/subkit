interface PagedBriefingTarget {
  owner: string;
  repository: string;
  projectUrl: string;
}

const PAGED_BRIEFING_TEMPLATE = `const s = input.scope;
const w = s.windows.data;
const owner = __OWNER__;
const repositoryName = __REPOSITORY__;
const base = 'https://github.com/' + owner + '/' + repositoryName;
const projectUrl = __PROJECT_URL__;
const ok = id => Boolean(s[id]) && !s[id].error && s[id].status_code === 200;
const data = id => ok(id) ? s[id].data : null;
const rows = id => Array.isArray(data(id)) ? data(id) : [];
const errorCode = id => s[id] && s[id].error && s[id].error.code || (s[id] && s[id].status_code ? 'http_' + s[id].status_code : 'request_error');
const incompleteCodes = ['graphql_pagination_incomplete', 'pagination_limit_reached', 'pagination_short_page', 'pagination_link_loop', 'pagination_link_unsupported', 'pagination_link_foreign'];
const reasonText = { limit_reached: 'eingestellte Seitengrenze erreicht', incomplete: 'Seiten oder Verbindungen unvollständig', rate_limited: 'Abrufgrenze des Anbieters erreicht', not_available: 'nicht abrufbar', unverified: 'Vollständigkeit vom Abruf nicht bestätigt', inconsistent: 'Anzahl weicht von der Repository-Zählung offener Einträge ab' };
const failedReason = id => {
  const code = s[id] && s[id].error && s[id].error.code;
  return code === 'upstream_rate_limited' ? 'rate_limited' : incompleteCodes.includes(code) ? 'incomplete' : 'not_available';
};
const uniqueBy = (list, key) => {
  const seen = new Set();
  return list.filter(row => {
    const value = row && row[key];
    if (value === undefined || value === null || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
};
const project = data('project_items');
const projectItems = project && project.user && project.user.projectV2 && project.user.projectV2.items;
const projectRows = projectItems && Array.isArray(projectItems.nodes) ? projectItems.nodes.filter(Boolean) : [];
const projectTotal = projectItems && typeof projectItems.totalCount === 'number' ? projectItems.totalCount : null;
const nestedIncomplete = connection => Boolean(connection) && (connection.pageInfo && connection.pageInfo.hasNextPage === true || typeof connection.totalCount === 'number' && Array.isArray(connection.nodes) && connection.nodes.length < connection.totalCount);
const nestedConnectionsIncomplete = projectRows.some(item => nestedIncomplete(item.content && item.content.labels) || nestedIncomplete(item.fieldValues));
const restSource = (id, count, paged) => {
  if (!ok(id)) return { source: id, complete: false, count: 0, duplicates_dropped: 0, reason: failedReason(id) };
  const pagination = s[id].pagination;
  const duplicates = pagination && typeof pagination.duplicates_dropped === 'number' ? pagination.duplicates_dropped : 0;
  if (!pagination) return paged ? { source: id, complete: false, count, duplicates_dropped: 0, reason: 'unverified' } : { source: id, complete: true, count, duplicates_dropped: 0, reason: null };
  if (pagination.truncated) return { source: id, complete: false, count, duplicates_dropped: duplicates, reason: 'limit_reached' };
  if (!pagination.complete) return { source: id, complete: false, count, duplicates_dropped: duplicates, reason: 'incomplete' };
  return { source: id, complete: true, count, duplicates_dropped: duplicates, reason: null };
};
const projectSource = () => {
  if (!ok('project_items')) return { source: 'project_items', complete: false, count: 0, duplicates_dropped: 0, reason: failedReason('project_items') };
  const pagination = s.project_items.pagination;
  if (!pagination) return { source: 'project_items', complete: false, count: projectRows.length, duplicates_dropped: 0, reason: 'unverified' };
  if (!pagination.complete || !projectItems || projectTotal === null || projectRows.length !== projectTotal || nestedConnectionsIncomplete) return { source: 'project_items', complete: false, count: projectRows.length, duplicates_dropped: 0, reason: 'incomplete' };
  return { source: 'project_items', complete: true, count: projectRows.length, duplicates_dropped: 0, reason: null };
};
const commits = uniqueBy(rows('commits'), 'sha');
const issueSourceRows = uniqueBy(rows('issues').concat(rows('issues_open')), 'id');
const issueRows = issueSourceRows.filter(row => !row.pull_request);
const prRows = issueSourceRows.filter(row => Boolean(row.pull_request));
const milestoneRows = uniqueBy(rows('milestones'), 'id');
const runRows = uniqueBy(rows('actions'), 'id');
const repoOpenCount = ok('repo') && typeof data('repo').open_issues_count === 'number' ? data('repo').open_issues_count : null;
const openConsistency = entry => !entry.complete || repoOpenCount === null || uniqueBy(rows('issues_open'), 'id').length === repoOpenCount ? entry : Object.assign({}, entry, { complete: false, reason: 'inconsistent' });
const completeness = [
  restSource('repo', ok('repo') ? 1 : 0, false),
  restSource('main_ref', ok('main_ref') ? 1 : 0, false),
  restSource('commits', commits.length, true),
  restSource('issues', rows('issues').length, true),
  openConsistency(restSource('issues_open', rows('issues_open').length, true)),
  restSource('actions', runRows.length, true),
  restSource('milestones', milestoneRows.length, true),
  projectSource(),
];
const missing = [];
for (const entry of completeness) {
  if (entry.reason === 'not_available') missing.push('Quelle nicht verfügbar: ' + entry.source + ' (' + errorCode(entry.source) + ').');
  else if (entry.reason === 'rate_limited') missing.push('Quelle nicht verfügbar: ' + entry.source + ' (' + reasonText.rate_limited + '; nach dem Zurücksetzen erneut ausführen).');
  else if (!entry.complete) missing.push('Quelle unvollständig gelesen: ' + entry.source + ' (' + reasonText[entry.reason] + ').');
}
const truncated = completeness.some(entry => !entry.complete);
const instant = value => /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/.test(value) ? value.slice(0, 19) + '.000Z' : value;
const inWindow = (value, start, end) => typeof value === 'string' && instant(value) >= instant(start) && instant(value) < instant(end);
const labels = row => Array.isArray(row.labels) ? row.labels.map(entry => entry && entry.name).filter(Boolean) : [];
const field = (item, name) => {
  const nodes = item && item.fieldValues && Array.isArray(item.fieldValues.nodes) ? item.fieldValues.nodes : [];
  const found = nodes.find(value => value && value.field && value.field.name === name);
  if (!found) return null;
  if (found.name != null) return found.name;
  if (found.text != null) return found.text;
  if (found.number != null) return String(found.number);
  if (found.date != null) return found.date;
  if (found.title != null) return found.title;
  return null;
};
const projectByUrl = new Map();
for (const item of projectRows) if (item.content && typeof item.content.url === 'string' && !projectByUrl.has(item.content.url)) projectByUrl.set(item.content.url, item);
const task = row => {
  const entry = projectByUrl.get(row.html_url) || null;
  const names = labels(row);
  const labeledPriority = names.find(value => /^priority:P[012]$/.test(value));
  return { number: row.number, title: row.title || '', state: row.state || 'unknown', state_reason: row.state_reason || null, labels: names, priority: field(entry, 'Priority') || (labeledPriority ? labeledPriority.slice(9) : 'unknown'), project_status: field(entry, 'Status'), track: field(entry, 'Track'), target: field(entry, 'Target'), milestone: row.milestone ? { number: row.milestone.number, title: row.milestone.title } : null, source_url: row.html_url || base + '/issues/' + row.number };
};
const openTasks = issueRows.filter(row => row.state === 'open').map(task);
const missingFields = openTasks.filter(row => !row.project_status || row.priority === 'unknown');
if (missingFields.length) missing.push('Project-Status oder Priorität fehlt für ' + missingFields.length + ' offene Issues.');
const head = data('main_ref');
const sha = head && head.object && head.object.sha || '';
if (!sha) missing.push('Aktueller main-SHA ist nicht verfügbar.');
missing.push('Aktuelle Release-Abnahme wird nicht automatisch aus Issue-Status, historischen Tests oder einem SHA abgeleitet. Verlinkte Nachweise und menschliche Freigabe gesondert prüfen.');
const prCompletedAt = row => row.pull_request && row.pull_request.merged_at || row.closed_at;
const counts = (start, end) => {
  const activeRuns = runRows.filter(row => inWindow(row.created_at, start, end));
  return { commits: commits.filter(row => inWindow(row.commit && row.commit.committer && row.commit.committer.date, start, end)).length, pulls_opened: prRows.filter(row => inWindow(row.created_at, start, end)).length, pulls_completed: prRows.filter(row => inWindow(prCompletedAt(row), start, end)).length, issues_opened: issueRows.filter(row => inWindow(row.created_at, start, end)).length, issues_completed: issueRows.filter(row => inWindow(row.closed_at, start, end)).length, workflow_runs: activeRuns.length, successful_runs: activeRuns.filter(row => row.conclusion === 'success').length, failed_runs: activeRuns.filter(row => ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(row.conclusion)).length };
};
const current = counts(w.current_start, w.now);
const previous = counts(w.previous_start, w.current_start);
const delta = {};
for (const key of Object.keys(current)) delta[key] = current[key] - previous[key];
const blockers = openTasks.filter(row => row.project_status === 'Blocked' || row.labels.some(value => /blocked|blocker|critical/i.test(value))).map(row => ({ kind: 'issue', summary: row.title, url: row.source_url }));
for (const row of runRows.filter(row => inWindow(row.created_at, w.current_start, w.now) && ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(row.conclusion))) blockers.push({ kind: 'workflow_run', summary: (row.name || 'CI') + ': ' + row.conclusion, url: row.html_url || base + '/actions' });
const milestoneProgress = milestoneRows.map(row => {
  const open = Number(row.open_issues || 0), closed = Number(row.closed_issues || 0), total = open + closed;
  return { number: row.number, title: row.title || '', state: row.state || 'unknown', open_issues: open, closed_issues: closed, completion_percent: total ? Math.round(closed * 10000 / total) / 100 : 0, due_on: row.due_on || null, updated_at: row.updated_at || null, url: row.html_url || base + '/milestone/' + row.number };
});
const ordered = openTasks.slice().sort((a, b) => String(a.priority).localeCompare(String(b.priority)) || a.number - b.number);
const next = ordered.slice(0, 8).map(row => ({ priority: row.priority, project_status: row.project_status || 'unknown', type: 'issue', action: row.title, source_url: row.source_url }));
const newlyCreated = issueRows.filter(row => inWindow(row.created_at, w.current_start, w.now));
const completed = issueRows.filter(row => row.state === 'closed' && inWindow(row.closed_at, w.current_start, w.now));
const release = { historical_checks: { status: 'migrated_to_wiki', documents_available: 0, checked_items: 0, unchecked_items: 0 }, current_acceptance: { status: 'not_established', basis: 'Kriterien und Status stehen in Issues/Project; Wiki enthält Konzepte und datierte Nachweise. Dieser Snapshot erteilt keine Release-Freigabe.' }, project: { url: projectUrl, available: ok('project_items'), item_count: projectRows.length, total_count: projectTotal, complete: completeness[completeness.length - 1].complete, missing_issue_fields: missingFields.map(row => row.number) }, open_tasks_count: openTasks.length };
const sources = [{ label: 'Repository', url: base }, { label: 'main', url: base + '/tree/main' }, { label: 'Issues', url: base + '/issues' }, { label: 'Project', url: projectUrl }, { label: 'Milestones', url: base + '/milestones' }, { label: 'Pull requests', url: base + '/pulls' }, { label: 'Actions', url: base + '/actions' }, { label: 'Wiki: Konzepte und Nachweise', url: base + '/wiki' }];
const summarizeTask = row => ({ number: row.number, title: row.title || '', priority: task(row).priority, source_url: row.html_url || base + '/issues/' + row.number });
const newShown = newlyCreated.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12).map(summarizeTask);
const completedShown = completed.slice().sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at))).slice(0, 12).map(summarizeTask);
const changes = { mode: w.mode, window_hours: w.mode === 'weekly' ? 168 : 24, possible_truncation: truncated, completeness, current, previous, delta, listed_tasks: { new_total: newlyCreated.length, new_shown: newShown.length, new_omitted: newlyCreated.length - newShown.length, completed_total: completed.length, completed_shown: completedShown.length, completed_omitted: completed.length - completedShown.length } };
return { repository: { full_name: owner + '/' + repositoryName, private: true, source_url: base }, fetched_at: w.now, main: { commit_sha: sha || null }, changes_since_previous_period: changes, blockers, release_progress: release, milestone_progress: milestoneProgress, new_tasks: newShown, completed_tasks: completedShown, missing_evidence: missing.map(message => ({ message })), prioritized_next_steps: next, sources };`;

export const renderPagedBriefing = (target: PagedBriefingTarget): string =>
  PAGED_BRIEFING_TEMPLATE.replace("__OWNER__", JSON.stringify(target.owner))
    .replace("__REPOSITORY__", JSON.stringify(target.repository))
    .replace("__PROJECT_URL__", JSON.stringify(target.projectUrl));
