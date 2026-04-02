import TelegramBot from 'node-telegram-bot-api';
import wol from 'wol';

const TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.CHAT_ID;
const MAC = process.env.TARGET_MAC;
const BROADCAST = process.env.BROADCAST_IP;

console.log('Iniciando bot...');
console.log('TOKEN:', TOKEN ? 'OK' : 'UNDEFINED');
console.log('CHAT_ID:', ALLOWED_CHAT_ID);
console.log('MAC:', MAC);
console.log('BROADCAST:', BROADCAST);

if (!TOKEN) {
  console.error('ERRO: BOT_TOKEN não definido!');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

bot.on('message', (msg) => {
  const chatId = String(msg.chat.id);

  if (chatId !== ALLOWED_CHAT_ID) {
    bot.sendMessage(chatId, '⛔ Não autorizado.');
    return;
  }

  const text = msg.text?.toLowerCase();

  if (text === '/ligar') {
    wol.wake(MAC, { address: BROADCAST }, (err) => {
      if (err) {
        bot.sendMessage(chatId, `❌ Erro: ${err.message}`);
      } else {
        bot.sendMessage(chatId, '✅ Magic Packet enviado! Aguarde ~30s.');
      }
    });
  } else if (text === '/start' || text === '/help') {
    bot.sendMessage(chatId, '🖥️ Bot WoL\n\nComandos:\n/ligar — Liga o PC');
  } else {
    bot.sendMessage(chatId, 'Comando não reconhecido. Use /ligar ou /help');
  }
});

console.log('Bot rodando...');