
    'use strict';

    /* ── Legacy migration and browser session keys ── */
    const STORAGE_KEY_USERS = 'dt_users_v2';
    const STORAGE_KEY_RECORDS = 'dt_records_v2';

    function appFetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      const userAgentData = navigator.userAgentData;
      const userAgent = navigator.userAgent || '';
      const deviceType = userAgentData?.mobile ? 'mobile' : (/ipad|tablet/i.test(userAgent) ? 'tablet' : (/mobile|iphone|android/i.test(userAgent) ? 'mobile' : 'desktop'));
      headers.set('X-Client-Platform', userAgentData?.platform || navigator.platform || 'unknown');
      headers.set('X-Client-Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown');
      headers.set('X-Client-Device-Type', deviceType);
      return fetch(url, { ...options, headers, credentials: 'same-origin' });
    }

    /* ── Application State ── */
    let currentUser = null;
    let records = [];
    let users = [];
    let projects = [];
    let activeTab = 'tracker';
    let dashboardDrilldownRecordIds = null;

    let currentEditingRecordId = null;
    let currentEditingUserId = null;
    let currentEditingProjectId = null;
    let currentViewingRecordId = null;
    let pendingConfirmAction = null;

    let searchDebounceTimer = null;
    let sortColumn = 'trackerNo';
    let sortDirection = 'asc';
    let currentPage = 1;
    let pageSize = 25;

    const buttonProgress = new WeakMap();
    function beginButtonProgress(button) {
      if (!button || !(button instanceof HTMLButtonElement)) return () => {};
      let state = buttonProgress.get(button);
      if (!state) {
        state = { holds: 0, timer: null, spinner: null, wasDisabled: button.disabled };
        buttonProgress.set(button, state);
      }
      clearTimeout(state.timer);
      state.holds++;
      button.disabled = true;
      button.classList.add('is-processing');
      button.setAttribute('aria-busy', 'true');
      if (!state.spinner) {
        state.spinner = document.createElement('span');
        state.spinner.className = 'button-spinner';
        state.spinner.setAttribute('aria-hidden', 'true');
        button.appendChild(state.spinner);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.holds = Math.max(0, state.holds - 1);
        if (state.holds) return;
        state.timer = setTimeout(() => {
          if (state.holds) return;
          state.spinner?.remove();
          state.spinner = null;
          button.classList.remove('is-processing');
          button.removeAttribute('aria-busy');
          button.disabled = state.wasDisabled;
          buttonProgress.delete(button);
        }, 140);
      };
    }

    function withButtonProgress(button, action) {
      const finish = beginButtonProgress(button);
      try {
        const result = action();
        const state = buttonProgress.get(button);
        if (state?.spinner && !state.spinner.isConnected) button.appendChild(state.spinner);
        return result && typeof result.then === 'function' ? result.finally(finish) : (finish(), result);
      } catch (error) {
        finish();
        throw error;
      }
    }

    function bindProgressHandler(button, handler) {
      button.dataset.progressWrapped = 'true';
      button.onclick = function(event) {
        return withButtonProgress(button, () => handler.call(this, event));
      };
    }

    function installButtonProgressHandlers(root = document) {
      root.querySelectorAll?.('button[onclick]').forEach(button => {
        if (button.dataset.progressWrapped === 'true') return;
        const source = button.getAttribute('onclick').trim();
        if (source.includes(';')) return;
        button.setAttribute('onclick', source.startsWith('return ') ? source : `return ${source}`);
        const handler = button.onclick;
        if (!handler) return;
        button.onclick = function(event) { return withButtonProgress(button, () => handler.call(this, event)); };
        button.dataset.progressWrapped = 'true';
      });
      root.querySelectorAll?.('form[onsubmit]').forEach(form => {
        if (form.dataset.progressWrapped === 'true') return;
        const source = form.getAttribute('onsubmit').trim();
        if (source.includes(';')) return;
        form.setAttribute('onsubmit', source.startsWith('return ') ? source : `return ${source}`);
        const handler = form.onsubmit;
        if (!handler) return;
        form.onsubmit = function(event) { return withButtonProgress(event.submitter, () => handler.call(this, event)); };
        form.dataset.progressWrapped = 'true';
      });
    }

    function initializeButtonProgress() {
      installButtonProgressHandlers();
      const observer = new MutationObserver(mutations => mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches('button[onclick],form[onsubmit]')) installButtonProgressHandlers(node.parentElement || document);
          else installButtonProgressHandlers(node);
        }
      })));
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('click', event => {
        const button = event.target.closest?.('button');
        if (!button || button.disabled || button.type === 'submit' || button.dataset.progressWrapped === 'true') return;
        const finish = beginButtonProgress(button);
        setTimeout(finish, 450);
      }, true);
    }

    /* ── Helper: Escape HTML ── */
    function escapeHTML(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function toLocalISODate(date = new Date()) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    /* ── Helper: Format Dates cleanly ── */
    function formatDate(dateStr) {
      if (!dateStr) return '<span style="color:var(--gray-400)">—</span>';
      try {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        }
        return dateStr;
      } catch (e) {
        return dateStr;
      }
    }

    function isOverdue(expectedDate, status) {
      if (!expectedDate) return false;
      if (status === 'Deployed' || status === 'Rejected') return false;
      const today = toLocalISODate();
      return expectedDate < today;
    }

    /* ── Load only legacy local data for the one-time database migration ── */
    async function initializeDatabase() {
      loadLegacyStateFromStorage();
    }

    function loadLegacyStateFromStorage() {
      try {
        users = JSON.parse(localStorage.getItem(STORAGE_KEY_USERS) || '[]');
        records = JSON.parse(localStorage.getItem(STORAGE_KEY_RECORDS) || '[]');
      } catch (e) {
        console.error('Failed to parse storage:', e);
        users = [];
        records = [];
      }
    }

    async function loadApplicationState(bootstrapState = null) {
      let remoteState = bootstrapState;
      if (!remoteState) {
        const response = await appFetch('/api/state', { headers: { Accept: 'application/json' } });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Could not load tracker data');
        remoteState = result.state;
      }
      remoteState = remoteState || { users: [], records: [], projects: [], needsMigration: false };
      projects = Array.isArray(remoteState.projects) ? remoteState.projects : [];
      if (remoteState.needsMigration && currentUser && currentUser.role === 'admin') {
        const mergedUsers = Array.isArray(remoteState.users) ? [...remoteState.users] : [];
        for (const legacyUser of users) {
          const legacyEmail = String(legacyUser.email || '').toLowerCase();
          const duplicate = mergedUsers.some(user => user.id === legacyUser.id || String(user.email || '').toLowerCase() === legacyEmail);
          if (!duplicate) mergedUsers.push(legacyUser);
        }
        users = mergedUsers;
        records = remoteState.records && remoteState.records.length ? remoteState.records : records;
        await persistApplicationState();
      } else {
        users = Array.isArray(remoteState.users) ? remoteState.users : [];
        records = Array.isArray(remoteState.records) ? remoteState.records : [];
      }

      // Remove data left by the old browser-only implementation after migration.
      localStorage.removeItem(STORAGE_KEY_USERS);
      localStorage.removeItem(STORAGE_KEY_RECORDS);
      localStorage.removeItem('dt_session_v2');
    }

    async function persistApplicationState() {
      const response = await appFetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ users, records, projects }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Could not save PostgreSQL data');
      if (Array.isArray(result.users)) users = result.users;
      if (Array.isArray(result.records)) records = result.records;
      if (Array.isArray(result.projects)) projects = result.projects;
      if (currentUser) currentUser = users.find(user => user.id === currentUser.id) || currentUser;
      localStorage.removeItem(STORAGE_KEY_USERS);
      localStorage.removeItem(STORAGE_KEY_RECORDS);
    }

    async function saveRecordsToDatabase() {
      return persistApplicationState();
    }

    async function saveUsersToDatabase() {
      return persistApplicationState();
    }

    /* ── Authentication & Session ── */
    async function checkAuthSession() {
      const response = await appFetch('/api/bootstrap', { headers: { Accept: 'application/json' } });
      if (response.status === 401) {
        showLoginView();
        return false;
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error || `Session check failed (${response.status})`);
      }
      const result = await response.json();
      if (!result.success || !result.user || !result.state) throw new Error(result.error || 'The tracker response was incomplete');
      currentUser = result.user;
      await loadApplicationState(result.state);
      showAppView();
      return true;
    }

    function showStartupError(error) {
      document.getElementById('view-login').style.display = 'none';
      document.getElementById('view-app').style.display = 'none';
      document.getElementById('view-startup-error').style.display = 'flex';
      document.getElementById('startup-error-message').textContent = error?.message || 'Could not connect to the tracker service.';
    }

    async function retryApplicationStartup() {
      try {
        await initializeDatabase();
        await checkAuthSession();
      } catch (error) {
        showStartupError(error);
      }
    }

    function showLoginView() {
      currentUser = null;
      document.getElementById('view-startup-error').style.display = 'none';
      document.getElementById('view-login').style.display = 'flex';
      document.getElementById('view-app').style.display = 'none';
      document.getElementById('input-email').value = '';
      document.getElementById('input-password').value = '';
      document.getElementById('login-alert').style.display = 'none';
    }

    function showAppView() {
      const returnTo = new URLSearchParams(window.location.search).get('return');
      if (['/dashboard.html', '/support.html', '/my-tracker.html'].includes(returnTo)) { window.location.replace(returnTo); return; }
      document.getElementById('view-startup-error').style.display = 'none';
      document.getElementById('view-login').style.display = 'none';
      document.getElementById('view-app').style.display = 'flex';

      // Update User Navigation Header
      const initials = currentUser.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
      document.getElementById('current-user-avatar').textContent = initials;
      document.getElementById('current-user-name').textContent = currentUser.name;
      document.getElementById('current-user-role').textContent = currentUser.role;

      // Admin tabs visibility
      const isAdmin = currentUser.role === 'admin';
      document.getElementById('tab-btn-users').style.display = isAdmin ? 'inline-flex' : 'none';
      document.getElementById('tab-btn-projects').style.display = isAdmin ? 'inline-flex' : 'none';

      // Control access for new record creation
      const canEdit = currentUser.role === 'admin' || currentUser.role === 'developer';
      document.getElementById('btn-add-record').style.display = canEdit && (isAdmin || projects.length > 0) ? 'inline-flex' : 'none';

      populateDepartmentFilter();
      populateProjectFilter();
      populateDeveloperFilter();
      updateStats();
      renderTable();
      const pageParams = new URLSearchParams(window.location.search);
      const recordIds = pageParams.get('recordIds');
      if (recordIds) {
        const ids = recordIds.split(',').filter(Boolean);
        dashboardDrilldownRecordIds = new Set(ids);
        const label = document.getElementById('dashboard-drilldown-label');
        const clearButton = document.getElementById('btn-clear-dashboard-drilldown');
        if (label) { label.textContent = `Selected requests · ${ids.length} records`; label.style.display = 'inline'; }
        if (clearButton) clearButton.style.display = 'inline-flex';
        renderTable();
        window.history.replaceState({}, '', '/');
      }
      if (pageParams.get('newSupport') === '1') {
        window.history.replaceState({}, '', '/');
        openRecordModal();
      }
      if (isAdmin) {
        renderUsersList();
        renderProjectsList();
      }
      const requestedView = pageParams.get('view');
      if (isAdmin && ['users', 'projects'].includes(requestedView)) switchView(requestedView);
    }

    document.getElementById('form-login').addEventListener('submit', async function(e) {
      e.preventDefault();
      const finishProgress = beginButtonProgress(e.submitter);
      const email = document.getElementById('input-email').value.trim().toLowerCase();
      const pass = document.getElementById('input-password').value;
      const alertEl = document.getElementById('login-alert');

      if (!email || !pass) {
        alertEl.textContent = 'Please enter both email and password.';
        alertEl.style.display = 'block';
        finishProgress();
        return;
      }

      try {
        const response = await appFetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email, password: pass }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          alertEl.textContent = result.error || 'Invalid email or password.';
          alertEl.style.display = 'block';
          return;
        }
        currentUser = result.user;
        await loadApplicationState();
        document.getElementById('input-password').value = '';
        showToast(`Welcome back, ${currentUser.name}!`, 'success');
        showAppView();
      } catch (error) {
        if (currentUser) showStartupError(error);
        else {
          alertEl.textContent = `Database sign-in failed: ${error.message}`;
          alertEl.style.display = 'block';
        }
      } finally {
        finishProgress();
      }
    });

    async function logout() {
      try { await appFetch('/api/logout', { method: 'POST' }); } catch (e) {}
      currentUser = null;
      showToast('Logged out successfully');
      showLoginView();
    }

    /* ── Navigation Tabs ── */
    function switchView(tab) {
      if (tab === 'dashboard') { window.location.href = '/dashboard.html'; return; }
      if (tab === 'support') { window.location.href = '/support.html'; return; }
      if (tab === 'my-tracker') { window.location.href = '/my-tracker.html'; return; }
      activeTab = tab;
      const isTracker = tab === 'tracker';
      const isUsers = tab === 'users';

      document.getElementById('tab-btn-tracker').classList.toggle('active', isTracker);
      document.getElementById('tab-btn-users').classList.toggle('active', isUsers);
      document.getElementById('tab-btn-projects').classList.toggle('active', tab === 'projects');

      document.getElementById('section-tracker').style.display = isTracker ? 'flex' : 'none';
      document.getElementById('section-users').style.display = isUsers ? 'flex' : 'none';
      document.getElementById('section-projects').style.display = tab === 'projects' ? 'flex' : 'none';

      if (currentUser?.role === 'admin' && isUsers) renderUsersList();
      if (currentUser?.role === 'admin' && tab === 'projects') renderProjectsList();
    }

    function clearDashboardDrilldown() {
      dashboardDrilldownRecordIds = null;
      document.getElementById('filter-developer').value = '';
      document.getElementById('filter-dept').value = '';
      document.getElementById('filter-project').value = '';
      document.getElementById('filter-status').value = '';
      document.getElementById('filter-type').value = '';
      document.getElementById('search-box').value = '';
      document.getElementById('dashboard-drilldown-label').style.display = 'none';
      document.getElementById('btn-clear-dashboard-drilldown').style.display = 'none';
      currentPage = 1;
      renderTable();
    }

    function formatEmailDate(dateValue) {
      if (!dateValue) return '';
      const parts = String(dateValue).split('-').map(Number);
      if (parts.length !== 3 || parts.some(Number.isNaN)) return String(dateValue);
      const date = new Date(parts[0], parts[1] - 1, parts[2]);
      const weekday = date.toLocaleDateString('en', { weekday: 'long' });
      const month = date.toLocaleDateString('en', { month: 'long' });
      return `${weekday}, ${String(parts[2]).padStart(2, '0')} ${month}, ${parts[0]}`;
    }

    function buildDeploymentEmailContent() {
      const headers = [
        'Application Name', 'Responsible Developer', 'Ticket Number', 'Description',
        'Business Approver Name', 'Business Approval Date', 'Change Risk',
        'Impacted Business Area', 'Remediation Strategy', 'Comment', 'ServiceNow Status',
        'Planned deployment Date', 'Actual Deployment Date', 'GitHub Feature Branch'
      ];
      const deploymentRecords = records.filter(record => record.status === 'In Deployment')
        .sort((a,b) => String(a.expectedProdDate || '').localeCompare(String(b.expectedProdDate || '')) || String(a.trackerNo || '').localeCompare(String(b.trackerNo || '')));
      const rows = deploymentRecords.map(record => [
        projects.find(project => project.id === record.projectId)?.name || '',
        record.developer || '', record.trackerNo || '', record.subject || '', record.owner || '',
        formatEmailDate(record.businessApprovalDate), record.changeRisk || '', record.impactedBusinessArea || '',
        record.remediationStrategy || '', record.comment || '', record.sfdcStatus || '',
        formatEmailDate(record.expectedProdDate), formatEmailDate(record.prodDeployDate), record.featureBranch || ''
      ]);
      const inlineTh = 'border:1px solid #cbd5e1;background:#eff6ff;padding:8px;text-align:left;vertical-align:top;font-weight:600;white-space:nowrap;';
      const inlineTd = 'border:1px solid #cbd5e1;padding:8px;text-align:left;vertical-align:top;';
      const htmlTable = `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;min-width:1500px"><thead><tr>${headers.map(header => `<th style="${inlineTh}">${escapeHTML(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td style="${inlineTd}">${escapeHTML(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      const html = `<p>Hi Team,</p><p>Please find below the deployment details for requests currently marked <strong>In Deployment</strong>.</p>${htmlTable}<p>Regards,</p>`;
      const plainText = `Hi Team,\n\nPlease find below the deployment details for requests currently marked In Deployment.\n\n${headers.join('\t')}\n${rows.map(row => row.join('\t')).join('\n')}\n\nRegards,`;
      return { headers, rows, html, plainText };
    }

    function openDeploymentEmailDraft() {
      const content = buildDeploymentEmailContent();
      document.getElementById('deployment-email-subject').value = `Planned deployment details — ${toLocalISODate()}`;
      document.getElementById('deployment-email-count').textContent = `${content.rows.length} request${content.rows.length === 1 ? '' : 's'} marked In Deployment will be included.`;
      document.getElementById('deployment-email-preview').innerHTML = content.rows.length ? content.html : '<p>There are no records currently marked In Deployment.</p>';
      openModal('modal-deployment-email');
    }

    async function copyDeploymentEmailSubject() {
      const subject = document.getElementById('deployment-email-subject').value;
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(subject);
        else {
          const temporary = document.createElement('textarea');
          temporary.value = subject;
          temporary.style.position = 'fixed';
          temporary.style.opacity = '0';
          document.body.appendChild(temporary);
          temporary.select();
          const copied = document.execCommand('copy');
          temporary.remove();
          if (!copied) throw new Error('Clipboard access is unavailable');
        }
        showToast('Email subject copied.', 'success');
      } catch (error) {
        showToast(`Could not copy the email subject: ${error.message}`, 'error');
      }
    }

    async function copyDeploymentEmail() {
      const content = buildDeploymentEmailContent();
      if (!content.rows.length) {
        showToast('There are no In Deployment records to include.', 'error');
        return;
      }
      const preview = document.getElementById('deployment-email-preview');
      try {
        let clipboardCopied = false;
        if (navigator.clipboard?.write && window.ClipboardItem) {
          try {
            await navigator.clipboard.write([new ClipboardItem({
              'text/html': new Blob([content.html], { type: 'text/html' }),
              'text/plain': new Blob([content.plainText], { type: 'text/plain' })
            })]);
            clipboardCopied = true;
          } catch (clipboardError) { /* Fall back to copying the rendered table. */ }
        }
        if (!clipboardCopied) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(preview);
          selection.removeAllRanges();
          selection.addRange(range);
          const copied = document.execCommand('copy');
          selection.removeAllRanges();
          if (!copied) throw new Error('Clipboard access is unavailable');
        }
        showToast('Email table copied. Paste it into your email draft.', 'success');
      } catch (error) {
        showToast(`Could not copy the email table: ${error.message}`, 'error');
      }
    }

    /* ── Search & Filter Logic ── */
    function onSearchChange() {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        currentPage = 1;
        renderTable();
      }, 250);
    }

    function populateDepartmentFilter() {
      const depts = Array.from(new Set(records.map(r => r.department).filter(Boolean))).sort();
      const sel = document.getElementById('filter-dept');
      const datalist = document.getElementById('dept-datalist');

      const currentVal = sel.value;
      sel.innerHTML = '<option value="">All Departments</option>';
      datalist.innerHTML = '';

      depts.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        if (d === currentVal) opt.selected = true;
        sel.appendChild(opt);

        const dlOpt = document.createElement('option');
        dlOpt.value = d;
        datalist.appendChild(dlOpt);
      });
    }

    function populateProjectFilter() {
      const select = document.getElementById('filter-project');
      const currentValue = select.value;
      select.innerHTML = '<option value="">All Assigned Projects</option>' + projects
        .map(project => `<option value="${escapeHTML(project.id)}">${escapeHTML(project.name)}</option>`).join('');
      if (projects.some(project => project.id === currentValue)) select.value = currentValue;
    }

    function populateDeveloperFilter() {
      const select = document.getElementById('filter-developer');
      const currentValue = select.value;
      const names = [...new Set(records.map(record => String(record.developer || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b));
      select.innerHTML = '<option value="">All Developers</option>' + names.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
      if (names.includes(currentValue)) select.value = currentValue;
    }

    function populateRecordProjectOptions(selectedId = '') {
      const select = document.getElementById('rec-project');
      select.innerHTML = '<option value="">Select project...</option>' + projects
        .map(project => `<option value="${escapeHTML(project.id)}">${escapeHTML(project.name)}</option>`).join('');
      if (selectedId && projects.some(project => project.id === selectedId)) select.value = selectedId;
      else if (projects.length === 1) select.value = projects[0].id;
    }

    function getFilteredRecords() {
      const searchTerm = document.getElementById('search-box').value.trim().toLowerCase();
      const deptFilter = document.getElementById('filter-dept').value;
      const projectFilter = document.getElementById('filter-project').value;
      const developerFilter = document.getElementById('filter-developer').value;
      const statusFilter = document.getElementById('filter-status').value;
      const typeFilter = document.getElementById('filter-type').value;

      return records.filter(r => {
        if (dashboardDrilldownRecordIds && !dashboardDrilldownRecordIds.has(r.id)) return false;
        if (deptFilter && r.department !== deptFilter) return false;
        if (projectFilter && r.projectId !== projectFilter) return false;
        if (developerFilter && String(r.developer || '').trim() !== developerFilter) return false;
        if (statusFilter && r.status !== statusFilter) return false;
        if (typeFilter && r.requestType !== typeFilter) return false;

        if (searchTerm) {
          const haystack = [
            r.trackerNo,
            projects.find(project => project.id === r.projectId)?.name,
            r.department,
            r.subject,
            r.requestType,
            r.developer,
            r.status,
            r.owner,
            r.changeRisk,
            r.impactedBusinessArea,
            r.remediationStrategy,
            r.comment,
            r.releasePR,
            r.featureBranch,
            r.sfdcStatus
          ].filter(Boolean).join(' ').toLowerCase();

          if (!haystack.includes(searchTerm)) return false;
        }

        return true;
      });
    }

    /* ── Summary Statistics ── */
    function updateStats() {
      let active = 0;
      let deployed = 0;
      let rejected = 0;
      let overdue = 0;

      records.forEach(r => {
        if (r.status === 'In Progress' || r.status === 'Open' || r.status === 'In Review' || r.status === 'Testing' || r.status === 'In Deployment') {
          active++;
        }
        if (r.status === 'Deployed') deployed++;
        if (r.status === 'Rejected') rejected++;
        if (isOverdue(r.expectedProdDate, r.status)) overdue++;
      });

      document.getElementById('stat-total').textContent = records.length;
      document.getElementById('stat-active').textContent = active;
      document.getElementById('stat-deployed').textContent = deployed;
      document.getElementById('stat-rejected').textContent = rejected;
      document.getElementById('stat-overdue').textContent = overdue;
    }

    /* ── Table Sorting ── */
    function sortTable(column) {
      if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = column;
        sortDirection = 'asc';
      }
      renderTable();
    }

    function updateSortHeaderStyles() {
      document.querySelectorAll('#tracker-table th[data-col]').forEach(th => {
        const col = th.getAttribute('data-col');
        const indicator = th.querySelector('.sort-indicator');
        if (col === sortColumn) {
          th.classList.add('sorted');
          indicator.textContent = sortDirection === 'asc' ? '▲' : '▼';
        } else {
          th.classList.remove('sorted');
          indicator.textContent = '▲';
        }
      });
    }

    /* ── Render Main Tracker Table ── */
    function renderTable() {
      updateSortHeaderStyles();
      const filtered = getFilteredRecords();

      // Sort
      filtered.sort((a, b) => {
        let valA = (a[sortColumn] || '').toString().toLowerCase();
        let valB = (b[sortColumn] || '').toString().toLowerCase();

        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });

      const totalItems = filtered.length;
      const totalPages = Math.ceil(totalItems / pageSize) || 1;
      if (currentPage > totalPages) currentPage = totalPages;
      if (currentPage < 1) currentPage = 1;

      const startIndex = (currentPage - 1) * pageSize;
      const pageData = filtered.slice(startIndex, startIndex + pageSize);

      const tbody = document.getElementById('tracker-tbody');
      const emptyState = document.getElementById('table-empty');

      if (totalItems === 0) {
        tbody.innerHTML = '';
        emptyState.style.display = 'block';
      } else {
        emptyState.style.display = 'none';
        const canEdit = currentUser && (currentUser.role === 'admin' || currentUser.role === 'developer');
        const isAdmin = currentUser && currentUser.role === 'admin';

        tbody.innerHTML = pageData.map(r => {
          const overdue = isOverdue(r.expectedProdDate, r.status);
          const prDisplay = r.releasePR ? (
            r.releasePR.startsWith('http')
              ? `<a href="${escapeHTML(r.releasePR)}" target="_blank" rel="noopener noreferrer" class="pr-link" onclick="event.stopPropagation()">View PR ↗</a>`
              : `<span class="pr-link" style="color:var(--gray-700)">${escapeHTML(r.releasePR)}</span>`
          ) : '<span style="color:var(--gray-400)">—</span>';

          const sfdcClass = r.sfdcStatus === 'Open' ? 'badge-sfdc-open' : (r.sfdcStatus === 'Closed' ? 'badge-sfdc-closed' : 'badge-sfdc-pending');
          const sfdcBadge = r.sfdcStatus ? `<span class="badge ${sfdcClass}">${escapeHTML(r.sfdcStatus)}</span>` : '<span style="color:var(--gray-400)">—</span>';

          const statusClass = 'badge-' + r.status.toLowerCase().replace(/\s+/g, '-');

          return `
            <tr class="${overdue ? 'row-overdue' : ''}" onclick="viewRecordDetails('${r.id}')">
              <td class="sticky-col">
                <div class="tracker-no-cell">
                  ${escapeHTML(r.trackerNo)}
                  ${overdue ? '<span class="badge-overdue" title="Past Expected Deployment Date">⚠️ Overdue</span>' : ''}
                </div>
              </td>
              <td>${escapeHTML(projects.find(project => project.id === r.projectId)?.name || 'Unassigned')}</td>
              <td>${escapeHTML(r.department)}</td>
              <td style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; font-weight: 500;" title="${escapeHTML(r.subject)}">
                ${escapeHTML(r.subject)}
              </td>
              <td>${escapeHTML(r.requestType)}</td>
              <td>${escapeHTML(r.developer)}</td>
              <td><span class="badge ${statusClass}">${escapeHTML(r.status)}</span></td>
              <td>${formatDate(r.expectedProdDate)}</td>
              <td>${formatDate(r.prodDeployDate)}</td>
              <td>${formatDate(r.businessApprovalDate)}</td>
              <td>${prDisplay}</td>
              <td>${formatDate(r.createdDate)}</td>
              <td>${escapeHTML(r.owner || '—')}</td>
              <td>${sfdcBadge}</td>
              <td class="action-cell" style="text-align: right;" onclick="event.stopPropagation()">
                <div style="display: inline-flex; gap: 4px;">
                  ${canEdit ? `
                    <button class="btn-icon" onclick="openRecordModal('${r.id}')" title="Edit Record">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    </button>
                  ` : ''}
                  ${isAdmin ? `
                    <button class="btn-icon delete" onclick="confirmDeleteRecord('${r.id}')" title="Delete Record">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  ` : ''}
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }

      // Pagination Controls
      document.getElementById('pagination-info').textContent =
        totalItems === 0
          ? '0 items'
          : `Showing ${startIndex + 1}-${Math.min(startIndex + pageSize, totalItems)} of ${totalItems}`;

      document.getElementById('btn-prev-page').disabled = currentPage <= 1;
      document.getElementById('btn-next-page').disabled = currentPage >= totalPages;
    }

    function changePageSize() {
      pageSize = parseInt(document.getElementById('page-size').value, 10);
      currentPage = 1;
      renderTable();
    }

    function prevPage() {
      if (currentPage > 1) {
        currentPage--;
        renderTable();
      }
    }

    function nextPage() {
      const filtered = getFilteredRecords();
      const totalPages = Math.ceil(filtered.length / pageSize) || 1;
      if (currentPage < totalPages) {
        currentPage++;
        renderTable();
      }
    }

    /* ── Add / Edit Tracker Record Modal ── */
    function openRecordModal(id = null) {
      currentEditingRecordId = id;
      const isEdit = Boolean(id);

      document.getElementById('modal-record-title').textContent = isEdit ? 'Edit Development Record' : 'New Development Record';
      document.getElementById('btn-save-record').textContent = isEdit ? 'Update Record' : 'Create Record';
      document.getElementById('optional-record-fields').open = isEdit;

      // Clear field feedback errors
      document.querySelectorAll('.input-feedback').forEach(f => f.classList.remove('visible'));
      document.querySelectorAll('.form-control').forEach(fc => fc.classList.remove('error'));

      if (isEdit) {
        const item = records.find(r => r.id === id);
        if (!item) return;

        document.getElementById('rec-trackerno').value = item.trackerNo || '';
        populateRecordProjectOptions(item.projectId || '');
        document.getElementById('rec-dept').value = item.department || '';
        document.getElementById('rec-subject').value = item.subject || '';
        document.getElementById('rec-type').value = item.requestType || '';
        document.getElementById('rec-developer').value = item.developer || '';
        document.getElementById('rec-status').value = item.status || 'Open';
        document.getElementById('rec-owner').value = item.owner || '';
        document.getElementById('rec-change-risk').value = item.changeRisk || '';
        document.getElementById('rec-impacted-area').value = item.impactedBusinessArea || '';
        document.getElementById('rec-remediation').value = item.remediationStrategy || '';
        document.getElementById('rec-comment').value = item.comment || '';
        document.getElementById('rec-expected-date').value = item.expectedProdDate || '';
        document.getElementById('rec-prod-date').value = item.prodDeployDate || '';
        document.getElementById('rec-approval-date').value = item.businessApprovalDate || '';
        document.getElementById('rec-pr').value = item.releasePR || '';
        document.getElementById('rec-feature-branch').value = item.featureBranch || '';
        document.getElementById('rec-sfdc').value = item.sfdcStatus || '';
        document.getElementById('rec-account').value = item.customerAccount || '';
        document.getElementById('rec-contact').value = item.customerContact || '';
        document.getElementById('rec-channel').value = item.supportChannel || '';
        document.getElementById('rec-priority').value = item.priority || '';
        document.getElementById('rec-category').value = item.category || '';
        document.getElementById('rec-sla-date').value = item.slaDueDate || '';
        document.getElementById('rec-contract').value = item.contractName || '';
        document.getElementById('rec-time-spent').value = Number(item.timeSpentMinutes) || 0;
        document.getElementById('rec-hourly-rate').value = Number(item.hourlyRate) || '';
      } else {
        document.getElementById('form-record').reset();
        populateRecordProjectOptions();
        // Auto-increment suggestion
        const nextNum = records.length + 1;
        const year = new Date().getFullYear();
        document.getElementById('rec-trackerno').value = `TRK-${year}-${String(nextNum).padStart(3, '0')}`;
        document.getElementById('rec-status').value = 'Open';
      }

      openModal('modal-record');
    }

    async function saveRecord(e) {
      e.preventDefault();
      const previousRecords = records.map(record => ({ ...record }));

      const trackerNo = document.getElementById('rec-trackerno').value.trim();
      const projectId = document.getElementById('rec-project').value;
      const department = document.getElementById('rec-dept').value.trim();
      const subject = document.getElementById('rec-subject').value.trim();
      const requestType = document.getElementById('rec-type').value;
      const developer = document.getElementById('rec-developer').value.trim();
      const status = document.getElementById('rec-status').value;
      const owner = document.getElementById('rec-owner').value.trim();
      const changeRisk = document.getElementById('rec-change-risk').value;
      const impactedBusinessArea = document.getElementById('rec-impacted-area').value.trim();
      const remediationStrategy = document.getElementById('rec-remediation').value.trim();
      const comment = document.getElementById('rec-comment').value.trim();
      const expectedProdDate = document.getElementById('rec-expected-date').value;
      const prodDeployDate = document.getElementById('rec-prod-date').value;
      const businessApprovalDate = document.getElementById('rec-approval-date').value;
      const releasePR = document.getElementById('rec-pr').value.trim();
      const featureBranch = document.getElementById('rec-feature-branch').value.trim();
      const sfdcStatus = document.getElementById('rec-sfdc').value;
      const customerAccount = document.getElementById('rec-account').value.trim();
      const customerContact = document.getElementById('rec-contact').value.trim();
      const supportChannel = document.getElementById('rec-channel').value;
      const priority = document.getElementById('rec-priority').value;
      const category = document.getElementById('rec-category').value.trim();
      const slaDueDate = document.getElementById('rec-sla-date').value;
      const contractName = document.getElementById('rec-contract').value.trim();
      const timeSpentMinutes = Math.max(0, Number(document.getElementById('rec-time-spent').value) || 0);
      const hourlyRate = Math.max(0, Number(document.getElementById('rec-hourly-rate').value) || 0);

      if (!trackerNo || !projectId || !department || !subject || !requestType || !developer || !status) {
        showToast('Please fill all required fields.', 'error');
        return;
      }

      // Check unique tracker number
      const duplicate = records.find(r => r.trackerNo.toLowerCase() === trackerNo.toLowerCase() && r.id !== currentEditingRecordId);
      if (duplicate) {
        showToast(`Tracker No. "${trackerNo}" already exists!`, 'error');
        return;
      }

      const today = toLocalISODate();

      if (currentEditingRecordId) {
        const idx = records.findIndex(r => r.id === currentEditingRecordId);
        if (idx !== -1) {
          records[idx] = {
            ...records[idx],
            trackerNo,
            projectId,
            department,
            subject,
            requestType,
            developer,
            status,
            owner,
            changeRisk,
            impactedBusinessArea,
            remediationStrategy,
            comment,
            expectedProdDate,
            prodDeployDate,
            businessApprovalDate,
            releasePR,
            featureBranch,
            sfdcStatus,
            customerAccount,
            customerContact,
            supportChannel,
            priority,
            category,
            slaDueDate,
            contractName,
            timeSpentMinutes,
            hourlyRate,
            updatedAt: today
          };
        }
      } else {
        const newRecord = {
          id: 'rec-' + Date.now(),
          trackerNo,
          projectId,
          department,
          subject,
          requestType,
          developer,
          status,
          owner,
          changeRisk,
          impactedBusinessArea,
          remediationStrategy,
          comment,
          expectedProdDate,
          prodDeployDate,
          businessApprovalDate,
          releasePR,
          featureBranch,
          sfdcStatus,
          customerAccount,
          customerContact,
          supportChannel,
          priority,
          category,
          slaDueDate,
          contractName,
          timeSpentMinutes,
          hourlyRate,
          createdBy: records.find(record => record.id === currentEditingRecordId)?.createdBy || currentUser?.id || '',
          createdDate: today
        };
        records.unshift(newRecord);
      }

      try {
        await saveRecordsToDatabase();
      } catch (error) {
        records = previousRecords;
        showToast(`Database save failed: ${error.message}`, 'error');
        return;
      }
      showToast(currentEditingRecordId ? 'Record updated successfully' : 'Record created successfully', 'success');
      closeModal('modal-record');
      populateDepartmentFilter();
      populateDeveloperFilter();
      updateStats();
      renderTable();
    }

    function confirmDeleteRecord(id) {
      const record = records.find(r => r.id === id);
      if (!record) return;

      document.getElementById('confirm-title').textContent = 'Delete Tracker Record';
      document.getElementById('confirm-msg').textContent = `Remove "${record.trackerNo} - ${record.subject}" from the active tracker?`;

      const confirmBtn = document.getElementById('btn-confirm-action');
      bindProgressHandler(confirmBtn, async () => {
        try {
          const response = await appFetch('/api/records', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || 'Could not remove record');
        } catch (error) {
          showToast(`Database save failed: ${error.message}`, 'error');
          return;
        }
        records = records.filter(r => r.id !== id);
        closeModal('modal-confirm');
        showToast('Record removed from the active tracker', 'success');
        populateDepartmentFilter();
        populateDeveloperFilter();
        updateStats();
        renderTable();
      });

      openModal('modal-confirm');
    }

    /* ── View Record Details Modal ── */
    function viewRecordDetails(id) {
      const item = records.find(r => r.id === id);
      if (!item) return;

      currentViewingRecordId = id;
      document.getElementById('view-modal-title').textContent = `${item.trackerNo} — Details`;

      const detailsContainer = document.getElementById('view-record-details');
      const canEdit = currentUser && (currentUser.role === 'admin' || currentUser.role === 'developer');
      document.getElementById('btn-quick-edit').style.display = canEdit ? 'inline-flex' : 'none';

      const fields = [
        { label: 'Tracker No.', value: item.trackerNo, span: false },
        { label: 'Project', value: projects.find(project => project.id === item.projectId)?.name || 'Unassigned', span: false },
        { label: 'Department', value: item.department, span: false },
        { label: 'Subject', value: item.subject, span: true },
        { label: 'Type of Request', value: item.requestType, span: false },
        { label: 'Developer', value: item.developer, span: false },
        { label: 'Status', value: item.status, span: false },
        { label: 'Business Approver Name', value: item.owner || '—', span: false },
        { label: 'Customer Account', value: item.customerAccount || '—', span: false },
        { label: 'Customer Contact', value: item.customerContact || '—', span: false },
        { label: 'Support Channel', value: item.supportChannel || '—', span: false },
        { label: 'Priority / Category', value: [item.priority, item.category].filter(Boolean).join(' · ') || '—', span: false },
        { label: 'Support Contract / Plan', value: item.contractName || '—', span: false },
        { label: 'SLA Due Date', value: formatDate(item.slaDueDate), span: false },
        { label: 'Time Spent', value: Number(item.timeSpentMinutes) ? `${item.timeSpentMinutes} minutes` : '—', span: false },
        { label: 'Hourly Billing Rate', value: Number(item.hourlyRate) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'INR' }).format(item.hourlyRate) : '—', span: false },
        { label: 'Change Risk', value: item.changeRisk || '—', span: false },
        { label: 'Impacted Business Area', value: item.impactedBusinessArea || '—', span: false },
        { label: 'Remediation Strategy', value: item.remediationStrategy || '—', span: true },
        { label: 'Comment', value: item.comment || '—', span: true },
        { label: 'Expected Prod Date', value: formatDate(item.expectedProdDate), span: false },
        { label: 'Prod Deployment Date', value: formatDate(item.prodDeployDate), span: false },
        { label: 'Business Approval Date', value: formatDate(item.businessApprovalDate), span: false },
        { label: 'Release Pull Request', value: item.releasePR || '—', span: false },
        { label: 'GitHub Feature Branch', value: item.featureBranch || '—', span: false },
        { label: 'Created Date', value: formatDate(item.createdDate), span: false },
        { label: 'ServiceNow Status', value: item.sfdcStatus || '—', span: false }
      ];

      detailsContainer.innerHTML = fields.map(f => `
        <div class="detail-item ${f.span ? 'span-full' : ''}">
          <span class="detail-label">${escapeHTML(f.label)}</span>
          <span class="detail-value">${f.label.includes('Date') ? f.value : escapeHTML(f.value)}</span>
        </div>
      `).join('');

      openModal('modal-view-record');
    }

    function triggerQuickEdit() {
      closeModal('modal-view-record');
      if (currentViewingRecordId) {
        openRecordModal(currentViewingRecordId);
      }
    }

    /* ── User Management Modal & Logic ── */
    function renderUsersList() {
      const container = document.getElementById('users-grid');
      container.innerHTML = users.map(u => {
        const initials = u.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const isSelf = currentUser && currentUser.id === u.id;
        const assignedProjects = (u.projectIds || []).map(id => projects.find(project => project.id === id)?.name).filter(Boolean);

        return `
          <div class="user-card">
            <div class="user-card-main">
              <div class="user-card-avatar">${initials}</div>
              <div class="user-card-meta">
                <span class="user-card-name">${escapeHTML(u.name)} ${isSelf ? '<small style="color:var(--primary)">(You)</small>' : ''}</span>
                <span class="user-card-email">${escapeHTML(u.email)}</span>
                <span class="user-role-badge user-role-${u.role}">${escapeHTML(u.role)}</span>
                <span class="user-card-email">Projects: ${assignedProjects.length ? escapeHTML(assignedProjects.join(', ')) : 'None assigned'}</span>
              </div>
            </div>

            <div style="display: flex; gap: 4px;">
              <button class="btn-icon" onclick="openUserModal('${u.id}')" title="Edit User">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              </button>
              ${!isSelf ? `
                <button class="btn-icon delete" onclick="confirmDeleteUser('${u.id}')" title="Delete User">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    function openUserModal(id = null) {
      currentEditingUserId = id;
      const isEdit = Boolean(id);

      document.getElementById('modal-user-title').textContent = isEdit ? 'Edit User Account' : 'Add New User';
      document.getElementById('btn-save-user').textContent = isEdit ? 'Update User' : 'Create User';

      const passInput = document.getElementById('user-password');
      const passHint = document.getElementById('user-password-hint');

      if (isEdit) {
        const u = users.find(x => x.id === id);
        if (!u) return;

        document.getElementById('user-name').value = u.name;
        document.getElementById('user-email').value = u.email;
        document.getElementById('user-role').value = u.role;
        populateUserProjectOptions(u.projectIds || []);
        passInput.value = '';
        passInput.required = false;
        passHint.textContent = 'Leave empty to keep current password.';
      } else {
        document.getElementById('form-user').reset();
        populateUserProjectOptions([]);
        passInput.required = true;
        passHint.textContent = 'Min. 6 characters.';
      }

      openModal('modal-user');
    }

    async function saveUser(e) {
      e.preventDefault();

      const name = document.getElementById('user-name').value.trim();
      const email = document.getElementById('user-email').value.trim().toLowerCase();
      const role = document.getElementById('user-role').value;
      const password = document.getElementById('user-password').value;
      const projectIds = Array.from(document.getElementById('user-projects').selectedOptions, option => option.value);

      if (!name || !email || !role) {
        showToast('Please fill all required fields.', 'error');
        return;
      }

      // Check duplicate email
      const dup = users.find(u => u.email.toLowerCase() === email && u.id !== currentEditingUserId);
      if (dup) {
        showToast('A user with this email already exists.', 'error');
        return;
      }

      const isEdit = Boolean(currentEditingUserId);
      if (currentEditingUserId) {
        if (password && password.length < 6) {
          showToast('Password must be at least 6 characters.', 'error');
          return;
        }
      } else {
        if (!password || password.length < 6) {
          showToast('Password must be at least 6 characters.', 'error');
          return;
        }

      }

      try {
        const response = await appFetch('/api/users', {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ id: currentEditingUserId, name, email, role, password, projectIds }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Could not save user');
        if (isEdit) {
          const idx = users.findIndex(u => u.id === currentEditingUserId);
          if (idx !== -1) users[idx] = result.user;
        } else {
          users.push(result.user);
        }
        if (currentUser && currentUser.id === result.user.id) currentUser = result.user;
      } catch (error) {
        showToast(`Database save failed: ${error.message}`, 'error');
        return;
      }
      showToast(isEdit ? 'User updated successfully' : `User "${name}" created successfully`, 'success');
      document.getElementById('user-password').value = '';
      closeModal('modal-user');
      renderUsersList();
    }

    function populateUserProjectOptions(selectedIds) {
      const select = document.getElementById('user-projects');
      select.innerHTML = projects.length
        ? projects.map(project => `<option value="${escapeHTML(project.id)}">${escapeHTML(project.name)} (${escapeHTML(project.type)})</option>`).join('')
        : '<option value="" disabled>No projects configured</option>';
      const selected = new Set(selectedIds);
      Array.from(select.options).forEach(option => { option.selected = selected.has(option.value); });
    }

    function renderProjectsList() {
      const container = document.getElementById('projects-grid');
      const empty = document.getElementById('projects-empty');
      empty.style.display = projects.length ? 'none' : 'block';
      container.innerHTML = projects.map(project => `
        <div class="user-card">
          <div class="user-card-main"><div class="user-card-meta">
            <span class="user-card-name">${escapeHTML(project.name)}</span>
            <span class="user-card-email">${escapeHTML(project.type)} · ${escapeHTML(project.startDate)} – ${escapeHTML(project.endDate)}</span>
          </div></div>
          <div style="display:flex;gap:4px">
            <button class="btn-icon" onclick="openProjectModal('${escapeHTML(project.id)}')" title="Edit project">✎</button>
            <button class="btn-icon delete" onclick="confirmDeleteProject('${escapeHTML(project.id)}')" title="Delete project">×</button>
          </div>
        </div>`).join('');
    }

    function openProjectModal(id = null) {
      currentEditingProjectId = id;
      document.getElementById('form-project').reset();
      document.getElementById('modal-project-title').textContent = id ? 'Edit Project' : 'Add Project';
      document.getElementById('btn-save-project').textContent = id ? 'Update Project' : 'Save Project';
      if (id) {
        const project = projects.find(item => item.id === id);
        if (!project) return;
        document.getElementById('project-name').value = project.name;
        document.getElementById('project-type').value = project.type;
        document.getElementById('project-start-date').value = project.startDate;
        document.getElementById('project-end-date').value = project.endDate;
      }
      openModal('modal-project');
    }

    async function saveProject(event) {
      event.preventDefault();
      const name = document.getElementById('project-name').value.trim();
      const type = document.getElementById('project-type').value.trim();
      const startDate = document.getElementById('project-start-date').value;
      const endDate = document.getElementById('project-end-date').value;
      if (!name || !type || !startDate || !endDate || endDate < startDate) {
        showToast('Enter all project details and ensure the end date is on or after the start date.', 'error');
        return;
      }
      if (projects.some(project => project.id !== currentEditingProjectId && project.name.toLowerCase() === name.toLowerCase())) {
        showToast('A project with this name already exists.', 'error');
        return;
      }
      const isEdit = Boolean(currentEditingProjectId);
      let response;
      try {
        response = await appFetch('/api/projects', {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ id: currentEditingProjectId, name, type, startDate, endDate }),
        });
      } catch (error) {
        showToast(`Could not save project: ${error.message}`, 'error');
        return;
      }
      let result;
      try { result = await response.json(); }
      catch { showToast('Could not read the project save response.', 'error'); return; }
      if (!response.ok || !result.success || !result.project) {
        showToast(result.error || 'Could not save project.', 'error');
        return;
      }
      const saved = result.project;
      projects = isEdit ? projects.map(project => project.id === saved.id ? saved : project) : [...projects, saved];
      closeModal('modal-project');
      populateProjectFilter();
      renderProjectsList();
      renderUsersList();
      renderTable();
      showToast(isEdit ? 'Project updated successfully.' : 'Project created successfully.', 'success');
    }

    function confirmDeleteProject(id) {
      const project = projects.find(item => item.id === id);
      if (!project) return;
      document.getElementById('confirm-title').textContent = 'Delete Project';
      document.getElementById('confirm-msg').textContent = `Archive ${project.name}? It will no longer appear in project assignments.`;
      bindProgressHandler(document.getElementById('btn-confirm-action'), async () => {
        try {
          const response = await appFetch('/api/projects', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || 'Could not archive project');
        } catch (error) { showToast(`Database save failed: ${error.message}`, 'error'); return; }
        projects = projects.filter(item => item.id !== id);
        users = users.map(user => ({ ...user, projectIds: (user.projectIds || []).filter(projectId => projectId !== id) }));
        closeModal('modal-confirm');
        populateProjectFilter();
        renderProjectsList();
        renderUsersList();
        renderTable();
        showToast('Project archived successfully.', 'success');
      });
      openModal('modal-confirm');
    }

    function confirmDeleteUser(id) {
      const user = users.find(u => u.id === id);
      if (!user) return;

      document.getElementById('confirm-title').textContent = 'Remove User';
      document.getElementById('confirm-msg').textContent = `Are you sure you want to remove ${user.name} (${user.email})?`;

      const confirmBtn = document.getElementById('btn-confirm-action');
      bindProgressHandler(confirmBtn, async () => {
        try {
          const response = await appFetch('/api/users', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || 'Could not remove user');
        } catch (error) {
          showToast(`Database save failed: ${error.message}`, 'error');
          return;
        }
        users = users.filter(u => u.id !== id);
        closeModal('modal-confirm');
        showToast('User removed from active access', 'success');
        renderUsersList();
      });

      openModal('modal-confirm');
    }

    /* ── Export CSV ── */
    function exportFilteredCSV() {
      const data = getFilteredRecords();
      if (!data.length) {
        showToast('No records to export.', 'error');
        return;
      }

      const headers = [
        'Tracker No.',
        'Department',
        'Subject',
        'Type of Request',
        'Developer',
        'Status',
        'Expected Prod Deployment Date',
        'Prod Deployment Date',
        'Business Approval Date',
        'Change Risk',
        'Impacted Business Area',
        'Remediation Strategy',
        'Comment',
        'Release Pull Request',
        'GitHub Feature Branch',
        'Created Date',
        'Business Approver Name',
        'ServiceNow Status'
      ];

      const keys = [
        'trackerNo',
        'department',
        'subject',
        'requestType',
        'developer',
        'status',
        'expectedProdDate',
        'prodDeployDate',
        'businessApprovalDate',
        'changeRisk',
        'impactedBusinessArea',
        'remediationStrategy',
        'comment',
        'releasePR',
        'featureBranch',
        'createdDate',
        'owner',
        'sfdcStatus'
      ];

      const csvRows = [
        headers.join(','),
        ...data.map(row => keys.map(k => {
          let val = (row[k] || '').toString();
          val = val.replace(/"/g, '""');
          return `"${val}"`;
        }).join(','))
      ];

      const blob = new Blob([csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `Tracker_Export_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      showToast('CSV export started');
    }

    /* ── Modal & Toast Helpers ── */
    function openModal(id) {
      const modal = document.getElementById(id);
      if (modal) modal.classList.add('open');
    }

    function closeModal(id) {
      const modal = document.getElementById(id);
      if (modal) modal.classList.remove('open');
    }

    // Close on backdrop click
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', function(e) {
        if (e.target === this) {
          this.classList.remove('open');
        }
      });
    });

    // Close on ESC key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
      }
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        const searchInput = document.getElementById('search-box');
        if (searchInput && document.getElementById('view-app').style.display !== 'none') {
          e.preventDefault();
          searchInput.focus();
        }
      }
    });

    function togglePasswordVisibility(inputId, btn) {
      const input = document.getElementById(inputId);
      if (input.type === 'password') {
        input.type = 'text';
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
      } else {
        input.type = 'password';
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
      }
    }

    function showToast(message, type = '') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = `toast ${type}`;
      toast.textContent = message;
      container.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 3200);
    }

    /* ── Application Startup ── */
    window.addEventListener('DOMContentLoaded', async () => {
      try {
        initializeButtonProgress();
        await initializeDatabase();
        await checkAuthSession();
      } catch (error) {
        console.error('Database initialization failed:', error);
        showStartupError(error);
      }
    });
