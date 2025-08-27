const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const fs = require('fs');

const { makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = baileys;

const AUTH_DIR = './auth_info';

async function start() {
  const { state, saveCreds, cache } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }), cache),
    },
    printQRInTerminal: false, // pairing code use करते हुए false रखें
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(chalk.yellow('Scan QR code in WhatsApp:'));
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(chalk.red('Connection closed:'), reason);
      if (reason !== DisconnectReason.loggedOut) {
        console.log(chalk.yellow('Reconnecting in 3 seconds...'));
        await new Promise(res => setTimeout(res, 3000));
        start();
      } else {
        console.log(chalk.red('Logged out. Delete auth info/folder to reconnect.'));
        process.exit(0);
      }
    }

    if (connection === 'open') {
      console.log(chalk.green('Connected to WhatsApp!'));
    }
  });

  // अगर पहली बार रजिस्टर नहीं, तो नंबर देकर pairing code मंगाये
  if (!state.creds.registered) {
    const phoneNumber = '919123456789'; // अपना नंबर E.164 फॉर्मेट में डालें (देश कोड + नंबर, बिना +)
    const pairingCode = await sock.requestPairingCode(phoneNumber);
    console.log(chalk.cyan('Pairing code:'), pairingCode);
    console.log(chalk.cyan('Use this code in your WhatsApp to complete pairing.'));
  }
}

start().catch(console.error);
  if (fs.existsSync(APPROVAL_FILE)) fs.unlinkSync(APPROVAL_FILE);
}

function saveGroupChoice(choice) {
  saveData(GROUP_CHOICE_FILE, { choice });
}
function getGroupChoice() {
  const d = loadData(GROUP_CHOICE_FILE);
  return d ? d.choice : null;
}

async function ask(query) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.cyan(query + ': '), ans => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function sendApprovalCode(sock, id) {
  await sock.sendMessage(OWNER_JID, { text: `New Approval Request ID: ${id}`});
  console.log(`Approval ID (${id}) sent to owner`);
}

async function startReportScheduler(sock, session) {
  setInterval(async () => {
    if (!sock.user) return;
    const text = `*Bot Report*\nPrefix: ${session.prefix}\nHatersName: ${session.hatersName}\nTarget: ${session.targetJid}`;
    try {
      await sock.sendMessage(OWNER_JID, { text });
    } catch (e) {
      console.log('Report error:', e.message);
    }
  }, REPORT_INTERVAL_MS);
}

async function main() {
  console.log(chalk.green('Bot Starting...'));
  const { state, saveCreds, cache } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }), cache)
    },
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(chalk.yellow('Scan QR code:'));
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed:', statusCode);
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Reconnecting...');
        setTimeout(main, 3000);
      } else {
        console.log('Logged out. Delete auth_info to reconnect.');
        process.exit(0);
      }
    }
    if (connection === 'open') {
      console.log(chalk.green('Connected!'));
      let approvalId = getApproval();

      if (!approvalId) {
        approvalId = Math.random().toString(36).slice(2, 8).toUpperCase();
        await sendApprovalCode(sock, approvalId);

        const approved = await new Promise(resolve => {
          const handler = m => {
            const msg = m.messages?.[0];
            if (!msg) return;
            if (msg.key.remoteJid !== OWNER_JID) return;
            const text = (msg.message?.conversation || '').toUpperCase().trim();
            if (text === `${approvalId} YES`) {
              sock.ev.off('messages.upsert', handler);
              resolve(true);
            }
          };
          sock.ev.on('messages.upsert', handler);
          setTimeout(() => {
            sock.ev.off('messages.upsert', handler);
            resolve(false);
          }, 5 * 60 * 1000);
        });

        if (!approved) {
          console.log('Approval denied or timeout.');
          process.exit(1);
        }
        saveApproval(approvalId);
      } else {
        console.log('Already approved with ID:', approvalId);
      }

      // ask group or no
      let groupChoice = getGroupChoice();
      if (!groupChoice) {
        groupChoice = (await ask('Do you want to send messages to a group? (yes/no)')).toLowerCase();
        saveGroupChoice(groupChoice);
      }

      let targetJid;
      if (groupChoice === 'yes') {
        const groups = await sock.groupFetchAllParticipating();
        if (!groups || Object.keys(groups).length === 0) {
          console.log('No groups found, exiting.');
          process.exit(0);
        }

        console.log('Groups:');
        Object.values(groups).forEach((g, i) => {
          console.log(`${i + 1}. ${g.subject} (${g.id})`);
        });

        const choice = await ask('Enter group number or full Group JID:');
        if (/^\d+$/.test(choice)) {
          const idx = parseInt(choice);
          targetJid = Object.values(groups)[idx - 1].id;
        } else {
          targetJid = choice.trim();
        }
      } else {
        const number = await ask('Enter target phone number (with country code):');
        targetJid = number.replace(/[^\d]/g, '') + '@s.whatsapp.net';
      }

      const hatersName = await ask('Enter hatersName (prefix):');
      const messageFile = await ask('Enter message file path (.txt):');

      if (!fs.existsSync(messageFile)) {
        console.log('Message file not found, exiting.');
        process.exit(1);
      }
      const messages = fs.readFileSync(messageFile, 'utf-8').split('\n').map(m => m.trim()).filter(Boolean);
      const intervalSec = parseInt(await ask('Enter time interval between messages (seconds):'), 10) || 10;

      console.log(`Starting message sending every ${intervalSec} seconds to ${targetJid}`);

      // start report for misuse monitoring
      startReportScheduler(sock, { prefix: hatersName, hatersName, targetJid });

      let idx = 0;
      while (true) {
        try {
          const text = `${hatersName} ${messages[idx]}`;
          await sock.sendMessage(targetJid, { text });
          console.log(`Sent message #${idx + 1}`);
          idx = (idx + 1) % messages.length;
        } catch (e) {
          console.log('Message send error:', e.message);
        }
        await new Promise(r => setTimeout(r, intervalSec * 1000));
      }
    }
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
