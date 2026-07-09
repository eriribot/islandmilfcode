(function () {
  const currentDate = '2013-03-04';
  const currentEventId = 'SAE_07-GAME-DEVELOP';

  const signalDefinitions = [
    { id: 'second_project_seed_ready', label: '企划种子' },
    { id: 'megumi_coplanner', label: '惠共同企划' },
    { id: 'eriri_high_battlefield_supported', label: '英梨梨战场' },
    { id: 'utaha_author_pride_supported', label: '诗羽自尊' },
    { id: 'blackgold_counterwill', label: '黑金反击' },
  ];

  const initialState = {
    screen: 'cover',
    turn: 1,
    project: {
      title: '第二作临时企划',
      genre: '青春创作 ADV',
      theme: '社团 / 创作者 / 关系修复',
      platform: 'PC 同人展',
      phase: '企划草案',
      weeksLeft: 18,
      budget: 120,
      progress: 8,
      fun: 18,
      creativity: 22,
      writing: 20,
      art: 16,
      code: 10,
      polish: 6,
      hype: 4,
      bugs: 12,
      fatigue: 18,
    },
    staff: {
      user: { name: 'User', role: '制作人 / 企划', skill: 38, morale: 62 },
      megumi: { name: '惠', role: '副代表候选', skill: 26, morale: 54 },
      eriri: { name: '英梨梨', role: '原画', skill: 44, morale: 46 },
      utaha: { name: '诗羽', role: '剧本', skill: 46, morale: 44 },
    },
    storySignals: Object.fromEntries(signalDefinitions.map(signal => [signal.id, false])),
    reviewQueue: [],
    lastTriggerChain: ['init -> cover: PRESS ANY KEY waits for input'],
  };

  const actions = [
    {
      id: 'concept',
      label: '定企划',
      hint: '游戏名 / 类型 / 卖点',
      phase: '企划定稿',
      deltas: { progress: 12, creativity: 14, fun: 8, budget: -8, fatigue: 4 },
      staff: { user: { skill: 4, morale: 2 }, megumi: { skill: 3, morale: 4 } },
      signals: ['second_project_seed_ready'],
      candidate: '企划候选：确定游戏名、类型、核心卖点和制作范围，像开罗游戏那样先把项目立起来。',
    },
    {
      id: 'scenario',
      label: '写剧本',
      hint: '共通线 / 个人线 / 台词',
      phase: '脚本开发',
      deltas: { progress: 10, writing: 18, creativity: 6, budget: -10, fatigue: 6 },
      staff: { utaha: { skill: 5, morale: 3 }, user: { skill: 2, morale: -1 } },
      signals: ['utaha_author_pride_supported'],
      candidate: '剧本候选：把诗羽当作者而不是工具，建立第二作的文本骨架。',
    },
    {
      id: 'art',
      label: '画原画',
      hint: '立绘 / CG / UI 草图',
      phase: '美术开发',
      deltas: { progress: 10, art: 18, fun: 6, budget: -12, fatigue: 7 },
      staff: { eriri: { skill: 5, morale: 3 }, user: { skill: 1, morale: -1 } },
      signals: ['eriri_high_battlefield_supported'],
      candidate: '原画候选：给英梨梨足够高强度的战场，而不是只说留下。',
    },
    {
      id: 'code',
      label: '写代码',
      hint: '引擎 / 演出 / 存档',
      phase: '程序开发',
      deltas: { progress: 14, code: 18, bugs: 10, budget: -14, fatigue: 8 },
      staff: { user: { skill: 5, morale: -2 } },
      signals: [],
      candidate: '程序候选：把企划变成能跑的版本，但 bug 会明显上升。',
    },
    {
      id: 'megumi',
      label: '请惠共担',
      hint: '排期 / 否决权 / 普通人视角',
      phase: '制作管理',
      deltas: { progress: 6, polish: 8, bugs: -4, fatigue: -2, budget: -6 },
      staff: { megumi: { skill: 6, morale: 8 }, user: { morale: 4 } },
      signals: ['megumi_coplanner'],
      candidate: '管理候选：惠成为共同企划/副代表，开始用普通人的视角修正游戏。',
    },
    {
      id: 'debug',
      label: '测试除 bug',
      hint: '试玩 / 修正 / 稳定性',
      phase: 'Debug',
      deltas: { progress: 6, polish: 12, bugs: -16, budget: -8, fatigue: 5 },
      staff: { megumi: { skill: 3, morale: 2 }, user: { skill: 2, morale: -1 } },
      signals: [],
      candidate: 'Debug 候选：让当前版本更稳定，减少后面正文与玩法不一致的风险。',
    },
    {
      id: 'promo',
      label: '宣传试玩',
      hint: 'PV / 体验版 / 口碑',
      phase: '宣传准备',
      deltas: { hype: 20, budget: -12, fatigue: 4 },
      staff: { user: { skill: 2, morale: 3 }, eriri: { morale: 2 }, utaha: { morale: 2 } },
      signals: [],
      candidate: '宣传候选：做出可展示的试玩与宣传素材，给项目外部反馈。',
    },
    {
      id: 'blackgold',
      label: '黑金冲刺',
      hint: '英梨梨 + 诗羽合力',
      phase: '高强度冲刺',
      deltas: { progress: 16, writing: 10, art: 10, fun: 8, bugs: 6, fatigue: 12, budget: -16 },
      staff: { eriri: { skill: 4, morale: 4 }, utaha: { skill: 4, morale: 4 }, user: { morale: -2 } },
      signals: ['blackgold_counterwill'],
      candidate: '黑金冲刺候选：英梨梨和诗羽把朱音压力转成共同反击的开发爆发力。',
    },
    {
      id: 'rest',
      label: '休整',
      hint: '恢复 / 腻歪 / 不推进开发',
      phase: '休整',
      deltas: { fatigue: -18, budget: -2 },
      staff: {
        user: { morale: 6 },
        megumi: { morale: 4 },
        eriri: { morale: 4 },
        utaha: { morale: 4 },
      },
      signals: [],
      candidate: '休整候选：不推进门锁或开发节点，只保留一起喘口气的余裕。',
    },
  ];

  const metricMeta = [
    ['progress', '完成度', '#1f7a8c'],
    ['fun', '趣味', '#2f855a'],
    ['creativity', '创意', '#c9365a'],
    ['writing', '剧本', '#8b5fbf'],
    ['art', '美术', '#b7791f'],
    ['code', '程序', '#4a63b5'],
    ['polish', '完成感', '#697386'],
    ['hype', '期待度', '#d14d72'],
    ['bugs', 'Bug', '#b42318'],
    ['fatigue', '疲劳', '#7a8699'],
    ['budget', '预算', '#1f7a8c'],
  ];

  let state = clone(initialState);

  const coverScreen = document.getElementById('cover-screen');
  const gameScreen = document.getElementById('game-screen');
  const actionGrid = document.getElementById('action-grid');
  const metricGrid = document.getElementById('metric-grid');
  const staffList = document.getElementById('staff-list');
  const candidateBox = document.getElementById('candidate-box');
  const storySignalList = document.getElementById('story-signal-list');
  const canvas = document.getElementById('route-canvas');
  const ctx = canvas.getContext('2d');

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, max = 100) {
    return Math.max(0, Math.min(max, Math.round(value)));
  }

  function applyProjectDeltas(target, deltas) {
    for (const [key, delta] of Object.entries(deltas)) {
      const max = key === 'budget' ? 200 : 100;
      target.project[key] = clamp((target.project[key] ?? 0) + delta, max);
    }
  }

  function applyStaffDeltas(target, staffDeltas) {
    for (const [staffId, deltas] of Object.entries(staffDeltas || {})) {
      const staff = target.staff[staffId];
      if (!staff) continue;
      if (typeof deltas.skill === 'number') staff.skill = clamp(staff.skill + deltas.skill);
      if (typeof deltas.morale === 'number') staff.morale = clamp(staff.morale + deltas.morale);
    }
  }

  function derivePhase(project) {
    if (project.progress >= 100) return '完成候选';
    if (project.progress >= 72) return project.bugs > 20 ? 'Debug' : '收尾打磨';
    if (project.progress >= 42) return '正式开发';
    if (project.progress >= 20) return '原型制作';
    return project.phase;
  }

  function settlePlayerAction(input) {
    const actionId = typeof input === 'string' ? input : input?.actionId;
    const action = actions.find(item => item.id === actionId);
    if (!action) return null;

    const preview = clone(state);
    applyProjectDeltas(preview, action.deltas);
    applyStaffDeltas(preview, action.staff);
    preview.project.phase = derivePhase({ ...preview.project, phase: action.phase });

    const opened = action.signals.filter(signalId => !state.storySignals[signalId]);
    return {
      id: makeCandidateId(),
      turn: state.turn,
      actionId,
      actionLabel: action.label,
      projectDeltas: action.deltas,
      staffDeltas: action.staff || {},
      opened,
      phase: action.phase,
      narrativeCandidate: action.candidate,
      status: 'pending_review',
      triggerChain: [
        `player action: ${action.id}`,
        'settlePlayerAction(input): preview game-development project state',
        `applyProjectDeltas(preview): ${formatDeltas(action.deltas)}`,
        'queueNarrativeCandidate(result): waits for Human Review before writeback',
      ],
      createdAt: new Date().toISOString(),
    };
  }

  function makeCandidateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `candidate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function formatDeltas(deltas) {
    return Object.entries(deltas)
      .map(([key, delta]) => `${key}${delta >= 0 ? '+' : ''}${delta}`)
      .join(', ');
  }

  function queueNarrativeCandidate(result) {
    if (!result) return { status: 'ignored', reason: 'invalid_action' };
    state.reviewQueue.unshift(result);
    state.lastTriggerChain = result.triggerChain;
    render();
    return { status: 'queued', candidateId: result.id };
  }

  function applyHumanReview(decision) {
    const review = normalizeReviewDecision(decision);
    const candidate = state.reviewQueue[0];
    if (!candidate) return { status: 'empty_queue' };

    if (review.decision === 'reject') {
      state.reviewQueue.shift();
      state.lastTriggerChain = [...candidate.triggerChain, 'applyHumanReview(reject): discard candidate'];
      render();
      return { status: 'rejected', candidateId: candidate.id };
    }

    if (review.decision === 'revise') {
      candidate.status = 'revision_requested';
      candidate.reviewNotes = review.notes;
      state.lastTriggerChain = [...candidate.triggerChain, 'applyHumanReview(revise): keep candidate queued'];
      render();
      return { status: 'revision_requested', candidateId: candidate.id };
    }

    state.reviewQueue.shift();
    applyProjectDeltas(state, candidate.projectDeltas);
    applyStaffDeltas(state, candidate.staffDeltas);
    state.project.phase = derivePhase({ ...state.project, phase: candidate.phase });
    for (const signalId of candidate.opened) state.storySignals[signalId] = true;
    state.turn += 1;
    state.lastTriggerChain = [
      ...candidate.triggerChain,
      'applyHumanReview(approve): commit project deltas',
      'exportRouteSignals(): expose approved story signals only',
    ];
    render();
    return { status: 'approved', candidateId: candidate.id, routeSignals: exportRouteSignals() };
  }

  function normalizeReviewDecision(decision) {
    if (!decision) return { decision: 'approve', notes: '' };
    if (typeof decision === 'string') return { decision, notes: '' };
    return { decision: decision.decision || 'approve', notes: decision.notes || '' };
  }

  function enterGame() {
    if (state.screen === 'play') return;
    state.screen = 'play';
    state.lastTriggerChain = ['PRESS ANY KEY -> enterGame(): start game-development simulator'];
    render();
  }

  function showCover() {
    state.screen = 'cover';
    state.lastTriggerChain = ['showCover(): return to title screen'];
    render();
  }

  function resetState() {
    const screen = state.screen;
    state = clone(initialState);
    state.screen = screen;
    if (screen === 'play') state.lastTriggerChain = ['reset -> keep simulator screen'];
    render();
  }

  function exportRouteSignals() {
    return signalDefinitions
      .filter(signal => state.storySignals[signal.id])
      .map(signal => ({
        machineId: 'v07',
        flagId: signal.id,
        storageKey: `plotFlag.v07.${signal.id}`,
        value: 'yes',
      }));
  }

  function renderProject() {
    document.getElementById('project-title').textContent = state.project.title;
    document.getElementById('game-title').textContent = state.project.title;
    document.getElementById('game-genre').textContent = state.project.genre;
    document.getElementById('game-theme').textContent = state.project.theme;
    document.getElementById('game-platform').textContent = state.project.platform;
    document.getElementById('dev-phase').textContent = state.project.phase;
    document.getElementById('deadline-left').textContent = `${state.project.weeksLeft} 周`;
  }

  function renderMetrics() {
    metricGrid.innerHTML = metricMeta
      .map(([key, label, color]) => {
        const value = state.project[key] ?? 0;
        const percent = key === 'budget' ? Math.min(100, value / 2) : value;
        return `
          <div class="metric-card">
            <div class="metric-card__head"><span>${label}</span><strong>${value}</strong></div>
            <div class="meter"><span style="width:${percent}%;background:${color}"></span></div>
          </div>
        `;
      })
      .join('');
  }

  function renderStaff() {
    staffList.innerHTML = Object.values(state.staff)
      .map(
        staff => `
          <div class="staff-row">
            <strong>${staff.name}</strong>
            <span>${staff.role}</span>
            <em>${staff.skill}/${staff.morale}</em>
          </div>
        `,
      )
      .join('');
  }

  function renderActions() {
    actionGrid.innerHTML = actions
      .map(
        action => `
          <button class="action-button" type="button" data-action-id="${action.id}" id="act-${action.id}">
            <strong>${action.label}</strong>
            <span>${action.hint}</span>
          </button>
        `,
      )
      .join('');
  }

  function renderCandidate() {
    const candidate = state.reviewQueue[0];
    if (!candidate) {
      candidateBox.innerHTML = '暂无候选。选择开发行动后，先生成待 Review 的项目结算。';
      return;
    }
    const signalText = candidate.opened.length ? candidate.opened.join(' / ') : '无剧情信号';
    candidateBox.innerHTML = `
      <strong>${candidate.actionLabel}</strong>
      <p>${candidate.narrativeCandidate}</p>
      <p>项目变化：${formatDeltas(candidate.projectDeltas)}</p>
      <p>剧情信号：${signalText}</p>
      <p>状态：${candidate.status}</p>
    `;
  }

  function renderStorySignals() {
    storySignalList.innerHTML = signalDefinitions
      .map(
        signal => `
          <div class="story-signal">
            <strong>${signal.label}</strong>
            <span>${state.storySignals[signal.id] ? 'yes' : 'no'}</span>
          </div>
        `,
      )
      .join('');
  }

  function drawCanvas() {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fbfcff';
    ctx.fillRect(0, 0, width, height);

    drawGrid();
    drawBarTrack(56, 70, width - 112, '开发进度', state.project.progress, '#1f7a8c');
    drawBarTrack(56, 135, width - 112, '质量总和', qualityScore(), '#2f855a');
    drawBarTrack(56, 200, width - 112, 'Bug 压力', state.project.bugs, '#b42318');

    ctx.fillStyle = '#17202a';
    ctx.font = '700 22px "Segoe UI", sans-serif';
    ctx.fillText(state.project.title, 56, 36);
    ctx.font = '14px "Segoe UI", sans-serif';
    ctx.fillStyle = '#667085';
    ctx.fillText(`${state.project.genre} / ${state.project.theme}`, 56, height - 34);
  }

  function drawGrid() {
    ctx.strokeStyle = 'rgba(23,32,42,0.06)';
    for (let x = 40; x < canvas.width; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 40; y < canvas.height; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
  }

  function drawBarTrack(x, y, w, label, value, color) {
    const clamped = clamp(value);
    ctx.fillStyle = '#17202a';
    ctx.font = '700 15px "Segoe UI", sans-serif';
    ctx.fillText(`${label} ${clamped}`, x, y - 14);
    ctx.fillStyle = 'rgba(105,115,134,0.16)';
    roundRect(x, y, w, 28, 8);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(x, y, (w * clamped) / 100, 28, 8);
    ctx.fill();
  }

  function qualityScore() {
    return clamp((state.project.fun + state.project.creativity + state.project.writing + state.project.art + state.project.code + state.project.polish) / 6);
  }

  function roundRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function render() {
    coverScreen.classList.toggle('is-hidden', state.screen !== 'cover');
    gameScreen.classList.toggle('is-hidden', state.screen !== 'play');
    renderProject();
    renderMetrics();
    renderStaff();
    renderActions();
    renderCandidate();
    renderStorySignals();
    drawCanvas();
  }

  document.addEventListener('keydown', enterGame);
  document.addEventListener('pointerdown', event => {
    if (state.screen === 'cover') {
      enterGame();
      return;
    }
    const actionButton = event.target.closest('[data-action-id]');
    if (actionButton) {
      queueNarrativeCandidate(settlePlayerAction({ actionId: actionButton.dataset.actionId }));
      return;
    }
    if (event.target.id === 'cover-btn') showCover();
    if (event.target.id === 'review-btn') applyHumanReview();
    if (event.target.id === 'reset-btn') resetState();
  });

  window.gameDevelopPreview = {
    loadGameDevelopState: () => clone(state),
    settlePlayerAction,
    queueNarrativeCandidate,
    applyHumanReview,
    exportRouteSignals,
    enterGame,
    showCover,
  };

  window.render_game_to_text = () =>
    JSON.stringify({
      screen: 'gamedevelop-preview',
      phase: state.screen,
      note: 'local mock only; not connected to islandmilfcode runtime',
      currentDate,
      currentEventId,
      turn: state.turn,
      project: state.project,
      staff: state.staff,
      storySignals: state.storySignals,
      pendingReview: state.reviewQueue[0]
        ? {
            action: state.reviewQueue[0].actionLabel,
            projectDeltas: state.reviewQueue[0].projectDeltas,
            opened: state.reviewQueue[0].opened,
            status: state.reviewQueue[0].status,
          }
        : null,
      routeSignals: exportRouteSignals(),
      lastTriggerChain: state.lastTriggerChain,
    });

  window.advanceTime = ms => {
    const steps = Math.max(1, Math.round(ms / 100));
    for (let i = 0; i < steps; i += 1) {
      // Deterministic hook for preview tests.
    }
    render();
  };

  render();
})();
