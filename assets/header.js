(() => {
  const mount = document.getElementById('app-header-mount');
  if (!mount) return;
  const page = document.body.dataset.page || 'tracker';
  const isTracker = page === 'tracker';
  const navItem = (name, href, active) => `<a class="nav-tab${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}>${name}</a>`;
  const trackerLink = isTracker
    ? '<button class="nav-tab active" id="tab-btn-tracker" type="button" onclick="switchView(\'tracker\')" aria-current="page">Tracker</button>'
    : navItem('Tracker', '/', false);
  const adminLinks = isTracker
    ? '<button class="nav-tab" id="tab-btn-users" type="button" onclick="switchView(\'users\')" style="display:none">User Management</button><button class="nav-tab" id="tab-btn-projects" type="button" onclick="switchView(\'projects\')" style="display:none">Projects</button>'
    : '<a class="nav-tab" href="/?view=users" data-admin-nav="true">User Management</a><a class="nav-tab" href="/?view=projects" data-admin-nav="true">Projects</a>';
  const logout = isTracker ? 'logout()' : 'portalLogout()';
  mount.outerHTML = `<header class="app-header"><div class="header-content"><div class="brand-section"><div class="brand-logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg></div><nav class="nav-tabs" aria-label="Application sections">${trackerLink}${navItem('Dashboard', '/dashboard.html', page === 'dashboard')}${navItem('Support Desk', '/support.html', page === 'support')}${navItem('My Tracker', '/my-tracker.html', page === 'my-tracker')}${adminLinks}</nav></div><div class="user-profile"><div class="user-avatar" id="current-user-avatar">?</div><div class="user-details"><span class="user-name" id="current-user-name">Loading…</span><span class="user-role" id="current-user-role"></span></div><button class="btn btn-secondary btn-sm" type="button" onclick="${logout}" title="Sign out">Logout</button></div></div></header>`;
})();
