const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const readline = require('readline');
const chalk = require('chalk');

const { makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = baileys;

const OWNER_JID_NUM = '919557954851';
const OWNER_JID = `${OWNER_JID_NUM}@s.whatsapp.net`;
const AUTH_DIR = './auth_info';
const DATA_DIR = './data';
const APPROVAL_FILE = `${DATA_DIR}/approval.json`;
const GROUP_CHOICE_FILE = `${DATA_DIR}/group_choice.json`;
const REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadData(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  return null;
}
function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function saveApproval(id) {
  saveData(APPROVAL_FILE, { id });
}
function getApproval() {
  const d = loadData(APPROVAL_FILE);
  return d ? d.id : null;
}

function clearApproval() {
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
