import TelegramBot from 'node-telegram-bot-api';
import wol from 'wol';

const TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHAT_ID = String(process.env.CHAT_ID ?? '');
const BROADCAST = process.env.BROADCAST_IP;

const DEVICES = {
  pc: { name: 'PC', mac: process.env.PC_MAC },
  tv: { name: 'TV LG', mac: process.env.TV_MAC },
};

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: 'Ligar PC' }, { text: 'Ligar TV' }],
    [{ text: 'Ligar Tudo' }, { text: 'Dispositivos' }],
    [{ text: 'Rede' }, { text: 'Ajuda' }],
    [{ text: 'Menu' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Escolha uma acao',
};

const COMMAND_ALIASES = new Map([
  ['/start', 'menu'],
  ['/help', 'ajuda'],
  ['/menu', 'menu'],
  ['/ligarpc', 'ligar pc'],
  ['/ligartv', 'ligar tv'],
  ['/ligar', 'ligar tudo'],
]);

const REQUIRED_CONFIG = [
  ['BOT_TOKEN', TOKEN],
  ['CHAT_ID', ALLOWED_CHAT_ID],
  ['BROADCAST_IP', BROADCAST],
];

const missingConfig = REQUIRED_CONFIG.filter(([, value]) => !value).map(([key]) => key);

if (missingConfig.length > 0) {
  console.error(`Erro: configure as variaveis ${missingConfig.join(', ')} antes de iniciar o bot.`);
  process.exit(1);
}

const configuredDeviceCount = Object.values(DEVICES).filter((device) => device.mac).length;

console.log(`Iniciando bot WoL com ${configuredDeviceCount} dispositivo(s) configurado(s).`);

const bot = new TelegramBot(TOKEN, { polling: true });

function normalizeAction(text = '') {
  const normalized = text.trim().toLowerCase();
  return COMMAND_ALIASES.get(normalized) ?? normalized;
}

function getMessageOptions() {
  return { reply_markup: MAIN_KEYBOARD };
}

function isAuthorized(chatId) {
  return String(chatId) === ALLOWED_CHAT_ID;
}

function maskMac(mac) {
  if (!mac) {
    return 'nao configurado';
  }

  const parts = mac.split(':');

  if (parts.length !== 6) {
    return mac;
  }

  return `${parts[0]}:${parts[1]}:${parts[2]}:**:**:${parts[5]}`;
}

function listDevices() {
  return Object.values(DEVICES).map((device) => {
    const status = device.mac ? 'pronto' : 'sem MAC configurado';
    return `- ${device.name}: ${maskMac(device.mac)} (${status})`;
  });
}

function sendMenu(chatId) {
  const configured = configuredDeviceCount === 1 ? '1 dispositivo pronto' : `${configuredDeviceCount} dispositivos prontos`;

  return bot.sendMessage(
    chatId,
    `Painel WoL\n\nUse os botoes abaixo para controlar os dispositivos.\n${configured}.`,
    getMessageOptions(),
  );
}

function sendHelp(chatId) {
  const text = [
    'Ajuda',
    '',
    '- Ligar PC: envia o magic packet somente para o PC.',
    '- Ligar TV: envia o magic packet somente para a TV.',
    '- Ligar Tudo: dispara o WoL para todos os dispositivos configurados.',
    '- Dispositivos: mostra o cadastro atual.',
    '- Rede: mostra o broadcast configurado.',
    '- Menu: reenvia o painel principal.',
  ].join('\n');

  return bot.sendMessage(chatId, text, getMessageOptions());
}

function sendDevices(chatId) {
  const text = ['Dispositivos cadastrados', '', ...listDevices()].join('\n');
  return bot.sendMessage(chatId, text, getMessageOptions());
}

function sendNetworkInfo(chatId) {
  const text = [
    'Configuracao de rede',
    '',
    `- Broadcast: ${BROADCAST}`,
    `- Porta WoL: 9`,
    `- Total de dispositivos: ${Object.keys(DEVICES).length}`,
    `- Configurados: ${configuredDeviceCount}`,
  ].join('\n');

  return bot.sendMessage(chatId, text, getMessageOptions());
}

function wakeDevice(device) {
  if (!device.mac) {
    return Promise.resolve({
      device,
      ok: false,
      skipped: true,
      error: 'MAC nao configurado',
    });
  }

  return new Promise((resolve) => {
    wol.wake(device.mac, { address: BROADCAST, port: 9 }, (error) => {
      if (error) {
        resolve({
          device,
          ok: false,
          skipped: false,
          error: error.message,
        });
        return;
      }

      resolve({
        device,
        ok: true,
        skipped: false,
      });
    });
  });
}

async function wakeDevices(chatId, keys) {
  const devices = keys.map((key) => DEVICES[key]).filter(Boolean);
  const results = await Promise.all(devices.map((device) => wakeDevice(device)));
  const lines = ['Resultado do envio', ''];

  for (const result of results) {
    if (result.ok) {
      lines.push(`- ${result.device.name}: magic packet enviado com sucesso.`);
      continue;
    }

    if (result.skipped) {
      lines.push(`- ${result.device.name}: ignorado (${result.error}).`);
      continue;
    }

    lines.push(`- ${result.device.name}: erro ao enviar (${result.error}).`);
  }

  lines.push('');
  lines.push('Se o dispositivo estiver configurado para WoL, aguarde cerca de 30 segundos.');

  return bot.sendMessage(chatId, lines.join('\n'), getMessageOptions());
}

async function handleAuthorizedMessage(msg) {
  const chatId = msg.chat.id;
  const action = normalizeAction(msg.text);

  switch (action) {
    case 'ligar pc':
      await wakeDevices(chatId, ['pc']);
      return;
    case 'ligar tv':
      await wakeDevices(chatId, ['tv']);
      return;
    case 'ligar tudo':
      await wakeDevices(chatId, ['pc', 'tv']);
      return;
    case 'dispositivos':
      await sendDevices(chatId);
      return;
    case 'rede':
      await sendNetworkInfo(chatId);
      return;
    case 'ajuda':
      await sendHelp(chatId);
      return;
    case 'menu':
      await sendMenu(chatId);
      return;
    default:
      await bot.sendMessage(
        chatId,
        'Nao reconheci essa acao. Use os botoes do menu abaixo.',
        getMessageOptions(),
      );
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  if (!isAuthorized(chatId)) {
    await bot.sendMessage(chatId, 'Nao autorizado.');
    return;
  }

  await handleAuthorizedMessage(msg);
});

bot.on('polling_error', (error) => {
  console.error('Erro no polling do Telegram:', error.message);
});

console.log('Bot rodando.');
