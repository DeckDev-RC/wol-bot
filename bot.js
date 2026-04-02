import TelegramBot from 'node-telegram-bot-api';
import wol from 'wol';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Config ──────────────────────────────────────────────
const TOKEN      = process.env.BOT_TOKEN;
const CHAT_ID    = process.env.CHAT_ID;
const PC_MAC     = process.env.PC_MAC;
const TV_MAC     = process.env.TV_MAC;
const BROADCAST  = process.env.BROADCAST_IP || '192.168.15.255';
const PC_IP      = process.env.PC_IP;
const AGENT_PORT = process.env.AGENT_PORT || '5050';
const AGENT_KEY  = process.env.AGENT_KEY || 'changeme';
const AGENT_URL  = `http://${PC_IP}:${AGENT_PORT}`;
const POLL_MS    = parseInt(process.env.POLL_INTERVAL_MS || '5000');

if (!TOKEN) { console.error('ERRO: BOT_TOKEN'); process.exit(1); }
if (!PC_IP) { console.error('ERRO: PC_IP'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('Controller iniciando...');

// ── Helpers ─────────────────────────────────────────────
const auth = (id) => String(id) === String(CHAT_ID);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sendWol(mac) {
  return new Promise((resolve, reject) => {
    wol.wake(mac, { address: BROADCAST, port: 9 }, err => err ? reject(err) : resolve());
  });
}

async function pingPC() {
  try {
    const cmd = process.platform === 'win32'
      ? `ping -n 1 -w 1000 ${PC_IP}` : `ping -c 1 -W 1 ${PC_IP}`;
    await execAsync(cmd);
    return true;
  } catch { return false; }
}

async function agentFetch(method, path, body = null) {
  const opts = {
    method,
    headers: { 'X-Agent-Key': AGENT_KEY, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${AGENT_URL}${path}`, opts);
  return res.json();
}

async function agentReady() {
  try {
    const data = await agentFetch('GET', '/health');
    return data.status === 'ok' && data.ready === true;
  }
  catch { return false; }
}

async function waitFor(fn, timeoutMs, intervalMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function editMsg(chatId, msgId, text, markup) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: markup });
  } catch { /* ignore edit errors */ }
}

// ── Menus ───────────────────────────────────────────────
const kb = {
  main: {
    inline_keyboard: [
      [{ text: '🖥 Status', callback_data: 'status' }, { text: '📊 Resumo do dia', callback_data: 'summary' }],
      [{ text: '⚡ Ligar PC', callback_data: 'wol:pc' }, { text: '📺 Ligar TV', callback_data: 'wol:tv' }],
      [{ text: '⚡ Ligar tudo', callback_data: 'wol:all' }],
      [{ text: '🤖 Automações', callback_data: 'menu:jobs' }],
      [{ text: '⏳ Ações pendentes', callback_data: 'menu:pending' }],
    ],
  },
  back: { inline_keyboard: [[{ text: '← Menu', callback_data: 'menu:main' }]] },
};

function jobsKeyboard(jobs) {
  const rows = jobs.map(j => {
    let icon = '🟢';
    if (j.has_interaction) icon = '🟡';
    else if (j.running) icon = '🔄';
    else if (j.paused) icon = '⏸';
    return [{ text: `${icon} ${j.name}`, callback_data: `job:view:${j.job_id}` }];
  });
  rows.push([{ text: '← Menu', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

function jobActionsKeyboard(job) {
  const rows = [
    [
      { text: '▶ Executar', callback_data: `job:run:${job.job_id}` },
      { text: '📋 Última execução', callback_data: `job:last:${job.job_id}` },
    ],
    [
      { text: job.paused ? '▶ Retomar' : '⏸ Pausar',
        callback_data: `job:${job.paused ? 'resume' : 'pause'}:${job.job_id}` },
      { text: '🔄 Atualizar', callback_data: `job:view:${job.job_id}` },
    ],
    [
      { text: '← Jobs', callback_data: 'menu:jobs' },
      { text: '← Menu', callback_data: 'menu:main' },
    ],
  ];
  return { inline_keyboard: rows };
}

function gssActionsKeyboard(job) {
  const rows = Object.entries(job.available_actions_labels).map(([key, label]) => (
    [{ text: label, callback_data: `run_cfg:gss:${job.job_id}:${key}` }]
  ));
  rows.push([{ text: '← Voltar', callback_data: `job:view:${job.job_id}` }]);
  return { inline_keyboard: rows };
}

function dazeYearKeyboard(jobId) {
  const y = new Date().getFullYear();
  return { inline_keyboard: [
    [y - 1, y, y + 1].map(yr => ({ text: String(yr), callback_data: `run_cfg:daze_year:${jobId}:${yr}` })),
    [{ text: '← Voltar', callback_data: `job:view:${jobId}` }],
  ]};
}

function dazeMonthKeyboard(jobId, year) {
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const rows = [];
  for (let i = 0; i < 12; i += 3) {
    rows.push(months.slice(i, i + 3).map((m, j) => ({
      text: m, callback_data: `run_cfg:daze_month:${jobId}:${year}:${i + j + 1}`,
    })));
  }
  rows.push([{ text: '← Trocar ano', callback_data: `run_cfg:daze:${jobId}` }]);
  return { inline_keyboard: rows };
}

function pendingKeyboard(interactions) {
  const rows = interactions.map(p => ([
    { text: `✅ Continuar ${p.job_id}`, callback_data: `interaction:approve:${p.id}` },
    { text: `❌ Cancelar ${p.job_id}`, callback_data: `interaction:reject:${p.id}` },
  ]));
  rows.push([
    { text: '🔄 Atualizar', callback_data: 'menu:pending' },
    { text: '← Menu', callback_data: 'menu:main' },
  ]);
  return { inline_keyboard: rows };
}

// ── Fluxo inteligente: Wake → Wait → Unlock → Run ──────
let cachedJobs = [];

async function smartRun(chatId, msgId, jobId, runtimeConfig = null) {
  const job = cachedJobs.find(j => j.job_id === jobId);
  const name = job?.name || jobId;

  const update = (text, mkup) => editMsg(chatId, msgId, text, mkup || kb.back);

  await update(`🔍 Verificando PC para ${name}...`);
  let online = await pingPC();

  if (!online) {
    await update(`📡 PC offline. Enviando Wake on LAN...`);
    try { await sendWol(PC_MAC); } catch (e) {
      return update(`❌ Erro WoL: ${e.message}`);
    }
    await update(`⏳ Aguardando PC ligar (máx 2 min)...`);
    online = await waitFor(pingPC, 120000);
    if (!online) return update(`❌ PC não respondeu após 2 min.`);
    await update(`✅ PC respondeu! Esperando agent...`);
  }

  const ready = await waitFor(agentReady, 120000);
  if (!ready) return update(`❌ Agent não respondeu. Verifique se está rodando no PC.`);

  await update(`🔓 Desbloqueando tela...`);
  try { await agentFetch('POST', '/unlock'); } catch { /* ok */ }
  await sleep(2000);

  await update(`🚀 Executando ${name}...`);
  try {
    const body = runtimeConfig ? { runtime_config: runtimeConfig } : {};
    const res = await agentFetch('POST', `/jobs/${jobId}/run`, body);
    if (res.accepted) {
      await update(`⏳ ${name} em execução.\nID: ${res.execution_id}\n\nVocê será notificado quando terminar.`);
    } else {
      await update(`⚠️ ${res.message}`);
    }
  } catch (e) {
    await update(`❌ Erro: ${e.message}`);
  }
}

// ── Polling de notificações do agent ────────────────────
async function pollNotifications() {
  try {
    const data = await agentFetch('GET', '/notifications');
    for (const n of data.notifications || []) {
      let text = '';
      const mkup = kb.back;

      if (n.type === 'success') {
        text = `✅ Concluído: ${n.job_name}\n` +
          `Execução: ${n.execution_id}\n` +
          `Tentativa: ${n.attempt}\n` +
          `Duração: ${n.duration || 'n/a'}\n` +
          (n.drive_link ? `Drive: ${n.drive_link}\n` : '') +
          (n.message ? `Resumo: ${n.message}` : '');
      } else if (n.type === 'failure') {
        text = `❌ Falhou: ${n.job_name}\n` +
          `Execução: ${n.execution_id}\n` +
          `Tentativa: ${n.attempt}\n` +
          (n.message ? `Resumo: ${n.message}\n` : '') +
          (n.error_details ? `Erro: ${n.error_details.substring(0, 300)}` : '');
      } else if (n.type === 'retry') {
        text = `🔄 Nova tentativa: ${n.job_name}\n` +
          `Tentativa: ${n.attempt}/${n.max_retries}\n` +
          `Reinício em: ${n.wait_seconds}s\n` +
          `Motivo: ${n.message}`;
      } else if (n.type === 'interaction') {
        text = `🟡 Ação necessária: ${n.job_name}\n` +
          `Pedido: ${n.prompt}\n` +
          (n.details ? `Detalhes: ${n.details}` : '');
        const iMkup = { inline_keyboard: [[
          { text: '✅ Continuar', callback_data: `interaction:approve:${n.interaction_id}` },
          { text: '❌ Cancelar', callback_data: `interaction:reject:${n.interaction_id}` },
        ]]};
        bot.sendMessage(CHAT_ID, text, { reply_markup: iMkup });
        continue;
      } else if (n.type === 'interaction_timeout') {
        text = `⏰ Interação expirou: ${n.job_name}\n${n.prompt}`;
      } else {
        continue;
      }

      bot.sendMessage(CHAT_ID, text, { reply_markup: mkup });
    }
  } catch { /* agent offline, ignora */ }
}

// Inicia polling se PC estiver online
setInterval(pollNotifications, POLL_MS);

// ── Command handler ─────────────────────────────────────
bot.on('message', (msg) => {
  if (!auth(msg.chat.id)) return bot.sendMessage(msg.chat.id, '⛔ Não autorizado.');
  const text = msg.text?.toLowerCase();
  if (text === '/start' || text === '/menu') {
    bot.sendMessage(msg.chat.id, '🏠 Painel de controle', { reply_markup: kb.main });
  } else if (text === '/help') {
    bot.sendMessage(msg.chat.id,
      '🏠 Comandos:\n/start — Menu principal\n/menu — Menu principal\n/help — Ajuda');
  }
});

// ── Callback handler ────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const msgId = query.message.message_id;
  const data = query.data;

  if (!auth(chatId)) {
    return bot.answerCallbackQuery(query.id, { text: 'Não autorizado', show_alert: true });
  }
  await bot.answerCallbackQuery(query.id);

  // ── Menus ──
  if (data === 'menu:main') {
    return editMsg(chatId, msgId, '🏠 Painel de controle', kb.main);
  }

  if (data === 'menu:jobs') {
    try {
      const res = await agentFetch('GET', '/jobs');
      cachedJobs = res.jobs || [];
      return editMsg(chatId, msgId, '🤖 Selecione um job:', jobsKeyboard(cachedJobs));
    } catch {
      return editMsg(chatId, msgId, '🔴 Agent offline. PC pode estar desligado.', kb.main);
    }
  }

  if (data === 'menu:pending') {
    try {
      const res = await agentFetch('GET', '/status');
      const pending = res.pending_interactions || [];
      const text = pending.length
        ? `⏳ ${pending.length} ação(ões) pendente(s):`
        : '✅ Nenhuma ação pendente.';
      return editMsg(chatId, msgId, text, pendingKeyboard(pending));
    } catch {
      return editMsg(chatId, msgId, '🔴 Agent offline.', kb.main);
    }
  }

  // ── Status ──
  if (data === 'status') {
    await editMsg(chatId, msgId, '🔍 Verificando...', kb.back);
    const online = await pingPC();
    let agentStatus = '🔴 Offline';
    if (online) {
      try {
        const health = await agentFetch('GET', '/health');
        if (health.status === 'ok' && health.ready) agentStatus = '🟢 Pronto';
        else if (health.status === 'ok') agentStatus = '🟡 Carregando...';
      } catch { /* offline */ }
    }
    const text = online
      ? `🖥 PC: 🟢 Online\n🤖 Agent: ${agentStatus}`
      : '🖥 PC: 🔴 Offline';
    return editMsg(chatId, msgId, text, kb.main);
  }

  if (data === 'summary') {
    try {
      const res = await agentFetch('GET', '/status');
      const text = `📊 Resumo do dia (${res.day_label})\n\n` +
        `Na fila: ${res.queued}\n` +
        `Executando: ${res.running}\n` +
        `Aguardando você: ${res.action_required}\n` +
        `Reprocessando: ${res.retrying}\n` +
        `Sucesso: ${res.success}\n` +
        `Falha: ${res.failed}\n` +
        `Pulados: ${res.skipped}`;
      return editMsg(chatId, msgId, text, kb.main);
    } catch {
      return editMsg(chatId, msgId, '🔴 Agent offline.', kb.main);
    }
  }

  // ── WoL ──
  if (data.startsWith('wol:')) {
    const target = data.split(':')[1];
    const targets = [];
    if (target === 'pc' || target === 'all') targets.push({ mac: PC_MAC, name: 'PC' });
    if (target === 'tv' || target === 'all') targets.push({ mac: TV_MAC, name: 'TV' });
    const results = [];
    for (const t of targets) {
      try { await sendWol(t.mac); results.push(`✅ ${t.name}: Magic Packet enviado`); }
      catch (e) { results.push(`❌ ${t.name}: ${e.message}`); }
    }
    return editMsg(chatId, msgId, results.join('\n'), kb.main);
  }

  // ── Job view ──
  if (data.startsWith('job:view:')) {
    const jobId = data.replace('job:view:', '');
    try {
      const res = await agentFetch('GET', `/jobs/${jobId}/detail`);
      let state = 'Pronto';
      if (res.running) state = 'Executando';
      else if (res.paused) state = 'Pausado';

      let text = `📋 ${res.name}\n\n` +
        `Estado: ${state}\n` +
        `Agenda: ${res.schedule_cron}\n` +
        `Próxima: ${res.next_run_at || 'n/a'}`;

      if (res.last_execution) {
        const le = res.last_execution;
        text += `\n\nÚltima execução:\n` +
          `Status: ${le.status}\n` +
          `Tentativa: ${le.attempt}\n` +
          `Início: ${le.started_at || 'n/a'}\n` +
          `Fim: ${le.finished_at || 'n/a'}\n` +
          `Resumo: ${(le.message || 'n/a').substring(0, 200)}`;
        if (le.drive_link) text += `\nDrive: ${le.drive_link}`;
      }

      const job = cachedJobs.find(j => j.job_id === jobId) || { job_id: jobId, paused: res.paused };
      return editMsg(chatId, msgId, text, jobActionsKeyboard(job));
    } catch {
      return editMsg(chatId, msgId, '🔴 Agent offline.', kb.main);
    }
  }

  // ── Job last execution ──
  if (data.startsWith('job:last:')) {
    const jobId = data.replace('job:last:', '');
    try {
      const res = await agentFetch('GET', `/jobs/${jobId}/detail`);
      const le = res.last_execution;
      const text = le
        ? `📋 Última execução: ${res.name}\n\n` +
          `ID: ${le.id}\nStatus: ${le.status}\nTentativa: ${le.attempt}\n` +
          `Início: ${le.started_at || 'n/a'}\nFim: ${le.finished_at || 'n/a'}\n` +
          `Resumo: ${(le.message || 'n/a').substring(0, 300)}\n` +
          (le.drive_link ? `Drive: ${le.drive_link}` : '')
        : `Ainda não existe histórico para ${jobId}.`;
      const job = cachedJobs.find(j => j.job_id === jobId) || { job_id: jobId, paused: false };
      return editMsg(chatId, msgId, text, jobActionsKeyboard(job));
    } catch {
      return editMsg(chatId, msgId, '🔴 Agent offline.', kb.main);
    }
  }

  // ── Job run (com seleção de ação/período) ──
  if (data.startsWith('job:run:')) {
    const jobId = data.replace('job:run:', '');
    const job = cachedJobs.find(j => j.job_id === jobId);

    // GSS com seleção de ação
    if (job?.run_option_preset === 'gss_action') {
      return editMsg(chatId, msgId, `Escolha o relatório para ${job.name}:`, gssActionsKeyboard(job));
    }

    // Daze com seleção de período
    if (job?.run_option_preset === 'daze_period') {
      return editMsg(chatId, msgId, `Escolha o ano para ${job.name}:`, dazeYearKeyboard(jobId));
    }

    // Demais jobs: executa direto
    smartRun(chatId, msgId, jobId);
    return;
  }

  // ── GSS action selection ──
  if (data.startsWith('run_cfg:gss:')) {
    const parts = data.split(':');
    const jobId = parts[2];
    const action = parts[3];
    const job = cachedJobs.find(j => j.job_id === jobId);
    const actionConfig = job?.available_actions_labels || {};
    const label = actionConfig[action] || action;

    await editMsg(chatId, msgId, `▶ ${job?.name || jobId}\nFluxo: ${label}`, kb.back);
    smartRun(chatId, msgId, jobId, {
      action,
      output_paths: (job?.available_actions?.[action]?.output_paths) || [],
    });
    return;
  }

  // ── Daze year selection ──
  if (data.startsWith('run_cfg:daze_year:')) {
    const parts = data.split(':');
    const jobId = parts[2];
    const year = parts[3];
    return editMsg(chatId, msgId, `Escolha o mês para ${year}:`, dazeMonthKeyboard(jobId, year));
  }

  // ── Daze: show year selection ──
  if (data.startsWith('run_cfg:daze:')) {
    const jobId = data.split(':')[2];
    return editMsg(chatId, msgId, 'Escolha o ano:', dazeYearKeyboard(jobId));
  }

  // ── Daze month selection → run ──
  if (data.startsWith('run_cfg:daze_month:')) {
    const parts = data.split(':');
    const jobId = parts[2];
    const year = parseInt(parts[3]);
    const month = parseInt(parts[4]);
    const months = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    await editMsg(chatId, msgId, `▶ Daze: ${months[month]}/${year}`, kb.back);
    smartRun(chatId, msgId, jobId, { month, year });
    return;
  }

  // ── Job pause/resume ──
  if (data.startsWith('job:pause:') || data.startsWith('job:resume:')) {
    const action = data.startsWith('job:pause:') ? 'pause' : 'resume';
    const jobId = data.replace(`job:${action}:`, '');
    try {
      const res = await agentFetch('POST', `/jobs/${jobId}/${action}`);
      await editMsg(chatId, msgId, res.message, kb.back);
      // Refresh job list
      try { cachedJobs = (await agentFetch('GET', '/jobs')).jobs || []; } catch {}
    } catch {
      await editMsg(chatId, msgId, '🔴 Agent offline.', kb.main);
    }
    return;
  }

  // ── Interactions ──
  if (data.startsWith('interaction:')) {
    const parts = data.split(':');
    const action = parts[1]; // approve or reject
    const interactionId = parts[2];
    const approved = action === 'approve';
    try {
      const res = await agentFetch('POST', `/interactions/${interactionId}/resolve`, { approved });
      const label = approved ? 'Continuidade autorizada' : 'Execução cancelada';
      await editMsg(chatId, msgId, `${label}.\n${res.message}`, kb.main);
    } catch (e) {
      await editMsg(chatId, msgId, `❌ Erro: ${e.message}`, kb.main);
    }
    return;
  }
});

console.log('Controller rodando. Polling notificações a cada', POLL_MS, 'ms');
