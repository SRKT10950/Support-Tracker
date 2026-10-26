(() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const todayIso = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const dateLabel = value => {
    if (!value) return '—';
    const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
    return year && month && day ? new Date(year, month - 1, day).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  };
  let user;
  let records = [];
  let page = document.body.dataset.page;

  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const agent = navigator.userAgent || '';
    const deviceType = /ipad|tablet/i.test(agent) ? 'tablet' : (/mobile|iphone|android/i.test(agent) ? 'mobile' : 'desktop');
    headers.set('X-Client-Platform', navigator.userAgentData?.platform || navigator.platform || 'unknown');
    headers.set('X-Client-Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown');
    headers.set('X-Client-Device-Type', deviceType);
    return fetch(path, { ...options, headers, credentials: 'same-origin' });
  }

  function currentIdentity() {
    return new Set([user?.id, user?.name, user?.email].map(value => String(value || '').trim().toLocaleLowerCase()).filter(Boolean));
  }

  function myRecords() {
    const identities = currentIdentity();
    return records.filter(record => record.createdBy === user.id || [record.developer, record.owner].some(name => identities.has(String(name || '').trim().toLocaleLowerCase())));
  }

  function detailButton(recordsToOpen, label) {
    const ids = recordsToOpen.map(record => record.id).filter(Boolean);
    return `<button class="drill" type="button" data-record-ids="${escapeHtml(ids.join(','))}" title="Open ${ids.length} matching tracker records">${escapeHtml(label)}</button>`;
  }

  function goToRecords(ids) {
    if (!ids) return;
    window.location.href = `/?recordIds=${encodeURIComponent(ids)}`;
  }

  const deploymentHeaders = ['Application Name', 'Responsible Developer', 'Ticket Number', 'Description', 'Business Approver Name', 'Business Approval Date', 'Change Risk', 'Impacted Business Area', 'Remediation Strategy', 'Comment', 'ServiceNow Status', 'Planned Deployment Date', 'Actual Deployment Date', 'GitHub Feature Branch'];
  let deploymentEmailHtml = '';
  let deploymentEmailText = '';

  function openDeploymentDraft() {
    const deployment = records.filter(record => record.status === 'In Deployment').sort((a,b) => String(a.expectedProdDate || '').localeCompare(String(b.expectedProdDate || '')) || String(a.trackerNo || '').localeCompare(String(b.trackerNo || '')));
    const rows = deployment.map(record => [
      record.projectName || '', record.developer || '', record.trackerNo || '', record.subject || '', record.owner || '', record.businessApprovalDate ? dateLabel(record.businessApprovalDate) : '',
      record.changeRisk || '', record.impactedBusinessArea || '', record.remediationStrategy || '', record.comment || '', record.sfdcStatus || '',
      record.expectedProdDate ? dateLabel(record.expectedProdDate) : '', record.prodDeployDate ? dateLabel(record.prodDeployDate) : '', record.featureBranch || '',
    ]);
    const htmlCell = value => `<td style="border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top">${escapeHtml(value)}</td>`;
    deploymentEmailHtml = `<p>Hi Team,</p><p>Please find below the deployment details for requests currently marked <strong>In Deployment</strong>.</p>${rows.length ? `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px"><thead><tr>${deploymentHeaders.map(header => `<th style="border:1px solid #cbd5e1;background:#f1f5f9;padding:7px 8px;text-align:left">${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(htmlCell).join('')}</tr>`).join('')}</tbody></table>` : '<p>There are no requests currently marked In Deployment.</p>'}<p>Regards,</p>`;
    deploymentEmailText = `Hi Team,\n\nPlease find below the deployment details for requests currently marked In Deployment.\n\n${deploymentHeaders.join('\t')}\n${rows.map(row => row.join('\t')).join('\n')}\n\nRegards,`;
    const date = new Date();
    document.getElementById('deployment-subject').value = `Deployment plan — ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`;
    document.getElementById('deployment-count').textContent = `${rows.length} request${rows.length === 1 ? '' : 's'} marked In Deployment will be included.`;
    document.getElementById('deployment-preview').innerHTML = rows.length ? deploymentEmailHtml : '<p>There are no records currently marked In Deployment.</p>';
    document.getElementById('deployment-copy-status').textContent = '';
    document.getElementById('deployment-dialog').showModal();
  }

  async function copyDeploymentMime(mime, textValue) {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const item = new ClipboardItem({
        'text/html': new Blob([deploymentEmailHtml], { type: 'text/html' }),
        'text/plain': new Blob([textValue], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
    } else await navigator.clipboard.writeText(textValue);
    document.getElementById('deployment-copy-status').textContent = `${mime} copied to clipboard.`;
  }

  window.openDeploymentDraft = openDeploymentDraft;
  window.copyDeploymentSubject = async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById('deployment-subject').value);
      document.getElementById('deployment-copy-status').textContent = 'Subject copied to clipboard.';
    } catch { document.getElementById('deployment-copy-status').textContent = 'Clipboard access is unavailable in this browser.'; }
  };
  window.copyDeploymentBody = async () => {
    try { await copyDeploymentMime('Email body', deploymentEmailText); }
    catch { document.getElementById('deployment-copy-status').textContent = 'Clipboard access is unavailable in this browser.'; }
  };

  function metric(label, count, items, note = '') {
    return `<div class="dashboard-metric">${detailButton(items, count)}<span>${escapeHtml(label)}</span>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
  }

  function installRecordLinks(root = document) {
    root.querySelectorAll('[data-record-ids]').forEach(button => button.addEventListener('click', () => goToRecords(button.dataset.recordIds)));
  }

  function renderDashboard() {
    const dev = document.getElementById('filter-developer');
    const periodControl = document.getElementById('filter-period');
    const yearControl = document.getElementById('filter-year');
    const monthControl = document.getElementById('filter-month');
    const dayControl = document.getElementById('filter-day');
    const previousDev = dev.value;
    const names = [...new Set(records.map(record => String(record.developer || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b));
    dev.innerHTML = '<option value="">All developers</option>' + names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    if (names.includes(previousDev)) dev.value = previousDev;
    const now = new Date();
    const currentYear = now.getFullYear();
    const years = [...new Set([...Array.from({ length: 10 }, (_, i) => currentYear - i), ...records.map(record => Number(String(record.createdDate || '').slice(0, 4))).filter(year => year >= 1900 && year <= 9999)])].sort((a,b) => b-a);
    const previousYear = yearControl.value;
    yearControl.innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join('');
    yearControl.value = years.includes(Number(previousYear)) ? previousYear : String(currentYear);
    const previousMonth = Number(monthControl.value) || now.getMonth() + 1;
    monthControl.innerHTML = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' })}</option>`).join('');
    monthControl.value = String(previousMonth);
    const daysInMonth = new Date(Number(yearControl.value), Number(monthControl.value), 0).getDate();
    const previousDay = Number(dayControl.value) || now.getDate();
    dayControl.innerHTML = Array.from({ length: daysInMonth }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    dayControl.value = String(Math.min(previousDay, daysInMonth));
    monthControl.style.display = ['month', 'day'].includes(periodControl.value) ? '' : 'none';
    dayControl.style.display = periodControl.value === 'day' ? '' : 'none';

    const period = periodControl.value, year = Number(yearControl.value), month = Number(monthControl.value), day = Number(dayControl.value), developer = dev.value;
    const periodDate = period === 'year' ? String(year) : period === 'month' ? `${year}-${String(month).padStart(2, '0')}` : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const selected = records.filter(record => {
      const created = String(record.createdDate || '');
      return created.startsWith(periodDate) && (!developer || String(record.developer || '').trim() === developer);
    });
    const activeStatuses = ['Open', 'In Progress', 'In Review', 'Testing', 'In Deployment'];
    const active = selected.filter(record => activeStatuses.includes(record.status));
    const deployed = selected.filter(record => record.status === 'Deployed');
    const rejected = selected.filter(record => record.status === 'Rejected');
    const overdue = selected.filter(record => record.expectedProdDate && record.expectedProdDate < todayIso() && !['Deployed', 'Rejected'].includes(record.status));
    const slaEligible = selected.filter(record => record.status === 'Deployed' && record.expectedProdDate && record.prodDeployDate);
    const onTime = slaEligible.filter(record => record.prodDeployDate <= record.expectedProdDate);
    const periodLabel = period === 'year' ? String(year) : period === 'month' ? new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : dateLabel(`${periodDate}`);
    document.getElementById('period-label').textContent = `${periodLabel} · ${selected.length} requests${developer ? ` · ${developer}` : ''}`;
    document.getElementById('dashboard-metrics').innerHTML = [
      metric('Total requests', selected.length, selected), metric('Ongoing', active.length, active), metric('Deployed', deployed.length, deployed), metric('Rejected', rejected.length, rejected), metric('Overdue', overdue.length, overdue),
      `<div class="dashboard-metric"><strong>${slaEligible.length ? `${Math.round(onTime.length * 100 / slaEligible.length)}%` : '—'}</strong><span>On-time deployment</span><small>${onTime.length} of ${slaEligible.length} eligible</small></div>`,
    ].join('');
    const statusNames = ['Open', 'In Progress', 'In Review', 'Testing', 'In Deployment', 'Deployed', 'Rejected'];
    const statusCounts = statusNames.map(status => [status, selected.filter(record => record.status === status)]);
    renderBars('status-report', statusCounts.map(([label, items]) => [label, items.length, items]));
    const typeNames = [...new Set(selected.map(record => record.requestType).filter(Boolean))].sort();
    renderBars('type-report', typeNames.map(label => [label, selected.filter(record => record.requestType === label).length, selected.filter(record => record.requestType === label)]));

    const throughputMonths = Array.from({ length: 12 }, (_, index) => {
      const key = `${year}-${String(index + 1).padStart(2, '0')}`;
      const created = records.filter(record => (!developer || String(record.developer || '').trim() === developer) && String(record.createdDate || '').startsWith(key));
      const released = records.filter(record => (!developer || String(record.developer || '').trim() === developer) && String(record.prodDeployDate || '').startsWith(key));
      return [new Date(year, index, 1).toLocaleDateString(undefined, { month: 'short' }), created, released];
    });
    const maxThroughput = Math.max(1, ...throughputMonths.flatMap(([, created, released]) => [created.length, released.length]));
    document.getElementById('throughput-report').innerHTML = throughputMonths.map(([label, created, released]) => `<div class="bar-row"><span>${label}</span><div><div class="bar-track"><div class="bar-fill" style="width:${created.length / maxThroughput * 100}%"></div></div><div class="bar-track" style="margin-top:3px"><div class="bar-fill alt" style="width:${released.length / maxThroughput * 100}%"></div></div></div><span>${detailButton(created, created.length)} / ${detailButton(released, released.length)}</span></div>`).join('') + '<small style="color:var(--gray-500)">Created / deployed</small>';
    const departments = [...new Set(selected.map(record => record.department).filter(Boolean))].sort();
    document.getElementById('department-report').innerHTML = departments.length ? `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Department</th><th>Total</th><th>Ongoing</th><th>Overdue</th><th>Deployed</th></tr></thead><tbody>${departments.map(name => {
      const items = selected.filter(record => record.department === name), pending = items.filter(record => activeStatuses.includes(record.status)), late = items.filter(record => record.expectedProdDate && record.expectedProdDate < todayIso() && !['Deployed', 'Rejected'].includes(record.status)), done = items.filter(record => record.status === 'Deployed');
      return `<tr><td>${escapeHtml(name)}</td><td>${detailButton(items, items.length)}</td><td>${detailButton(pending, pending.length)}</td><td>${detailButton(late, late.length)}</td><td>${detailButton(done, done.length)}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="empty-note">No requests for this period.</p>';
    const developers = [...new Set(selected.map(record => record.developer).filter(Boolean))].sort();
    document.getElementById('developer-report').innerHTML = developers.length ? `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Developer</th><th>Total</th><th>Ongoing</th><th>Overdue</th><th>Deployed</th></tr></thead><tbody>${developers.map(name => {
      const items = selected.filter(record => record.developer === name), pending = items.filter(record => activeStatuses.includes(record.status)), late = items.filter(record => record.expectedProdDate && record.expectedProdDate < todayIso() && !['Deployed', 'Rejected'].includes(record.status)), done = items.filter(record => record.status === 'Deployed');
      return `<tr><td>${escapeHtml(name)}</td><td>${detailButton(items, items.length)}</td><td>${detailButton(pending, pending.length)}</td><td>${detailButton(late, late.length)}</td><td>${detailButton(done, done.length)}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="empty-note">No developer records for this period.</p>';
    installRecordLinks();
  }

  function renderBars(elementId, rows) {
    const target = document.getElementById(elementId);
    const max = Math.max(1, ...rows.map(([, count]) => count));
    target.innerHTML = rows.length ? rows.map(([label, count, items]) => `<div class="bar-row"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${count / max * 100}%"></div></div>${detailButton(items, count)}</div>`).join('') : '<p class="empty-note">No requests for this selection.</p>';
  }

  function renderSupport() {
    const active = records.filter(record => !['Deployed', 'Rejected'].includes(record.status));
    const soon = new Date(); soon.setDate(soon.getDate() + 2);
    const soonIso = todayIsoFrom(soon);
    const slaRisk = active.filter(record => record.slaDueDate && record.slaDueDate <= soonIso);
    const bill = record => Math.max(0, Number(record.timeSpentMinutes) || 0) / 60 * Math.max(0, Number(record.hourlyRate) || 0);
    const money = amount => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount || 0);
    const accountSet = new Set(records.map(record => String(record.customerAccount || '').trim()).filter(Boolean));
    const totalBilled = records.reduce((sum, record) => sum + bill(record), 0);
    document.getElementById('support-metrics').innerHTML = [
      `<div class="dashboard-metric"><strong>${accountSet.size}</strong><span>Customer accounts</span></div>`,
      `<div class="dashboard-metric"><strong>${active.length}</strong><span>Open requests</span></div>`,
      `<div class="dashboard-metric"><strong>${slaRisk.length}</strong><span>SLA due / at risk</span><small>Overdue or due in 48 hours</small></div>`,
      `<div class="dashboard-metric"><strong>${escapeHtml(money(totalBilled))}</strong><span>Tracked billable value</span><small>Time spent × hourly rate</small></div>`,
    ].join('');
    const accounts = new Map();
    records.filter(record => String(record.customerAccount || '').trim()).forEach(record => {
      const name = record.customerAccount.trim();
      if (!accounts.has(name)) accounts.set(name, []);
      accounts.get(name).push(record);
    });
    const accountRows = [...accounts.entries()].sort((a,b) => b[1].reduce((s,r) => s + bill(r), 0) - a[1].reduce((s,r) => s + bill(r), 0));
    document.getElementById('support-accounts').innerHTML = accountRows.length ? `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Account</th><th>Requests</th><th>Open</th><th>Tracked value</th><th>Support plans</th></tr></thead><tbody>${accountRows.map(([name, items]) => `<tr><td>${detailButton(items, name)}</td><td>${detailButton(items, items.length)}</td><td>${detailButton(items.filter(record => !['Deployed','Rejected'].includes(record.status)), items.filter(record => !['Deployed','Rejected'].includes(record.status)).length)}</td><td>${escapeHtml(money(items.reduce((sum,record) => sum + bill(record),0)))}</td><td>${escapeHtml([...new Set(items.map(record => record.contractName).filter(Boolean))].join(', ') || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-note">No account details yet.</p>';
    const channels = new Map();
    records.forEach(record => { const name = record.supportChannel || 'Unspecified'; if (!channels.has(name)) channels.set(name, []); channels.get(name).push(record); });
    const channelRows = [...channels.entries()].sort((a,b) => b[1].length - a[1].length);
    const maxChannel = Math.max(1, ...channelRows.map(([, items]) => items.length));
    document.getElementById('support-channels').innerHTML = channelRows.length ? channelRows.map(([name, items]) => `<div class="bar-row"><span>${escapeHtml(name)}</span><div class="bar-track"><div class="bar-fill" style="width:${items.length / maxChannel * 100}%"></div></div>${detailButton(items, items.length)}</div>`).join('') : '<p class="empty-note">No channel details yet.</p>';
    const watch = slaRisk.sort((a,b) => String(a.slaDueDate).localeCompare(String(b.slaDueDate))).slice(0, 30);
    document.getElementById('support-sla-watch').innerHTML = watch.length ? `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Ticket</th><th>Customer</th><th>Priority</th><th>Developer</th><th>Status</th><th>SLA due</th><th>Risk</th></tr></thead><tbody>${watch.map(record => `<tr><td>${detailButton([record], `${record.trackerNo} · ${record.subject}`)}</td><td>${escapeHtml(record.customerAccount || '—')}</td><td>${escapeHtml(record.priority || '—')}</td><td>${escapeHtml(record.developer || '—')}</td><td>${escapeHtml(record.status)}</td><td>${dateLabel(record.slaDueDate)}</td><td style="color:${record.slaDueDate < todayIso() ? 'var(--danger)' : 'var(--warning)'};font-weight:700">${record.slaDueDate < todayIso() ? 'Overdue' : 'Due soon'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-note">No requests are overdue or due within 48 hours.</p>';
    installRecordLinks();
  }

  function todayIsoFrom(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }

  function renderMyTracker() {
    let selection = 'ongoing';
    const mine = myRecords();
    const closed = new Set(['Deployed', 'Rejected']);
    const draw = () => {
      const rows = mine.filter(record => selection === 'closed' ? closed.has(record.status) : !closed.has(record.status));
      document.getElementById('my-ticket-count').textContent = `${rows.length} ${selection} request${rows.length === 1 ? '' : 's'}`;
      document.querySelectorAll('[data-my-view]').forEach(button => button.classList.toggle('active', button.dataset.myView === selection));
      document.getElementById('my-ticket-list').innerHTML = rows.length ? `<div style="overflow-x:auto"><table class="report-table"><thead><tr><th>Ticket</th><th>Subject</th><th>Project</th><th>Developer</th><th>Status</th><th>Created</th><th>Expected</th></tr></thead><tbody>${rows.map(record => `<tr><td><button class="ticket-link" type="button" data-ticket="${escapeHtml(record.id)}">${escapeHtml(record.trackerNo)}</button></td><td>${escapeHtml(record.subject)}</td><td>${escapeHtml(record.projectName || '—')}</td><td>${escapeHtml(record.developer || '—')}</td><td>${escapeHtml(record.status)}</td><td>${dateLabel(record.createdDate)}</td><td>${dateLabel(record.expectedProdDate)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="empty-note">No ${selection} requests are assigned to or created by you.</p>`;
      document.querySelectorAll('[data-ticket]').forEach(button => button.addEventListener('click', () => showTicket(rows.find(record => record.id === button.dataset.ticket))));
    };
    document.querySelectorAll('[data-my-view]').forEach(button => button.addEventListener('click', () => { selection = button.dataset.myView; draw(); }));
    draw();
  }

  function showTicket(record) {
    if (!record) return;
    document.getElementById('ticket-dialog-title').textContent = `${record.trackerNo} · ${record.subject}`;
    const fields = [
      ['Project', record.projectName], ['Department', record.department], ['Type', record.requestType], ['Status', record.status],
      ['Developer', record.developer], ['Owner', record.owner], ['Created', dateLabel(record.createdDate)], ['Expected deployment', dateLabel(record.expectedProdDate)],
      ['Actual deployment', dateLabel(record.prodDeployDate)], ['Customer account', record.customerAccount], ['Priority', record.priority], ['SLA due', dateLabel(record.slaDueDate)],
      ['Support plan', record.contractName], ['Comment', record.comment],
    ];
    document.getElementById('ticket-dialog-content').innerHTML = fields.map(([label, value]) => `<div class="detail-field"><small>${escapeHtml(label)}</small><span>${escapeHtml(value || '—')}</span></div>`).join('');
    document.getElementById('ticket-dialog').showModal();
  }

  window.portalLogout = async () => {
    await apiFetch('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  };

  window.portalRetry = () => window.location.reload();

  function showPortalError(error) {
    const target = document.getElementById('portal-error');
    target.hidden = false;
    target.textContent = `Could not load this page: ${error.message}`;
    const retry = document.createElement('button');
    retry.className = 'btn btn-secondary btn-sm';
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.style.marginTop = '.75rem';
    retry.addEventListener('click', window.portalRetry);
    target.appendChild(retry);
  }

  async function boot() {
    try {
      const sessionResponse = await apiFetch('/api/session');
      if (sessionResponse.status === 401) { window.location.href = `/?return=${encodeURIComponent(window.location.pathname)}`; return; }
      const session = await sessionResponse.json().catch(() => ({}));
      if (!sessionResponse.ok || !session.success || !session.user) throw new Error(session.error || `Session check failed (${sessionResponse.status})`);
      user = session.user;
      const stateResponse = await apiFetch(page === 'my-tracker' ? '/api/state?scope=my-tracker' : '/api/state');
      if (stateResponse.status === 401) { window.location.href = `/?return=${encodeURIComponent(window.location.pathname)}`; return; }
      const state = await stateResponse.json().catch(() => ({}));
      if (!stateResponse.ok || !state.success) throw new Error(state.error || 'Unable to load tracker records');
      const projects = state.state.projects || [];
      const projectMap = new Map(projects.map(project => [project.id, project.name]));
      records = (state.state.records || []).map(record => ({ ...record, projectName: projectMap.get(record.projectId) || 'Unassigned' }));
      document.getElementById('current-user-name').textContent = user.name;
      document.getElementById('current-user-role').textContent = user.role;
      document.getElementById('current-user-avatar').textContent = user.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
      if (page === 'dashboard') {
        ['filter-developer', 'filter-period', 'filter-year', 'filter-month', 'filter-day'].forEach(id => document.getElementById(id).addEventListener('change', renderDashboard));
        renderDashboard();
      } else if (page === 'support') renderSupport();
      else if (page === 'my-tracker') renderMyTracker();
    } catch (error) {
      showPortalError(error);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
