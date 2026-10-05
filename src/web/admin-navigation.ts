// All labels and SVG paths are static application-owned strings, never user data.
const navigation = [
  ['overview', '总览', 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z'],
  ['spaces', '记忆空间', 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  ['memories', '记忆管理', 'M5 3h12l2 2v16H5z M9 8h6 M9 12h6 M9 16h4'],
  ['conflicts', '冲突确认', 'M12 3 2 21h20z M12 9v5 M12 17h.01'],
  ['jobs', '后台任务', 'M4 5h16v14H4z M8 9h8 M8 13h5 M8 17h2'],
  ['audit', '审计日志', 'M5 4h14v17H5z M9 2h6v4H9z M8 10h8 M8 14h8 M8 18h5'],
  ['agents', 'Agent 密钥', 'M14 3a7 7 0 0 0-6 10L3 18v3h4v-3h3l3-3a7 7 0 1 0 1-12z M17 7h.01'],
  ['clients', '客户端', 'M3 4h18v13H3z M8 21h8 M12 17v4'],
  ['security', '账号安全', 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6'],
  ['authentik', '身份认证', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21v-2a8 6 0 0 1 16 0v2'],
  ['providers', '模型 Provider', 'M7 7h10v10H7z M9 1v6 M15 1v6 M9 17v6 M15 17v6 M1 9h6 M1 15h6 M17 9h6 M17 15h6'],
  ['management', '工作区管理', 'M4 4h16v16H4z M4 10h16 M10 10v10'],
  ['about', '关于', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-5 M12 8h.01']
] as const;
export const navigationHtml = '<div class="nav-caption">WORKSPACE / 工作台</div>' + navigation.map(([view, label, path]) => {
  const attributes = view === 'overview' ? ' class="active" aria-current="page"'
    : view === 'authentik' ? ' id="authentikNav" style="display:none"'
      : view === 'providers' ? ' id="providerNav" style="display:none"' : '';
  return `<button type="button"${attributes} data-view="${view}"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>${label}</button>`;
}).join('');
