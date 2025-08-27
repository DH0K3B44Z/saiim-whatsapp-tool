const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const readline = require('readline');
const chalk = require('chalk');

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = baileys;

const APPROVAL_FILE = './approvals.json';
const GROUP_CHOICE_FILE = './group_choice.json';
const AUTH_DIR = './auth_info';

function loadApprovals() {
  if (fs.existsSync(APPROVAL_FILE)) {
    return JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf-8'));
  }
  return {};
}

function saveApprovals(data) {
  fs.writeFileSync(APPROVAL_FILE, JSON.stringify(data, null, 2));
}

function approveUser(number) {
  const data = loadApprovals();
  data[number] = true;
  saveApprovals(data);
  console.log(`User ${number} approved.`);
}

function removeApproval(number) {
  const data = loadApprovals();
  if (data[number]) {
    delete data[number];
    saveApprovals(data);
    console.log(`User ${number} का approval हटा दिया गया।`);
  } else {
    console.log(`User ${number} का approval नहीं मिला।`);
  }
}

function isApproved(number) {
  const data = loadApprovals();
  return !!data[number];
}

function loadGroupChoice() {
  if (fs.existsSync(GROUP_CHOICE_FILE)) {
    return JSON.parse(fs.readFileSync(GROUP_CHOICE_FILE, 'utf-8'));
  }
  return null;
}

function saveGroupChoice(choice) {
  fs.writeFileSync(GROUP_CHOICE_FILE, JSON.stringify(choice));
}

async function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.cyan(question + ' (saiim): '), ans => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function start() {
  console.log(chalk.green('WhatsApp Baileys Bot Started'));

  const { state, saveCreds, cache } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }), cache),
    },
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log(chalk.yellow('Scan this QR in WhatsApp to connect:'));
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log(chalk.red(`Connection closed: ${status}`));
      if (status !== DisconnectReason.loggedOut) {
        console.log(chalk.yellow('Reconnecting in 3 seconds...'));
        await new Promise(res => setTimeout(res, 3000));
        start();
      } else {
        console.log(chalk.red('Logged out. Please delete auth info to reconnect.'));
        process.exit(0);
      }
    }

    if (connection === 'open') {
      console.log(chalk.green('Connected to WhatsApp!'));

      // Approval check
      const ownerNumber = sock.user.id.split('@')[0];
      if (!isApproved(ownerNumber)) {
        console.log(chalk.yellow('Approval not found. Waiting for approval message...'));
        const approvalCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        await sock.sendMessage(sock.user.id, { text: `Approve this code to start bot: ${approvalCode}` });

        const approved = await new Promise((resolve) => {
          const handler = async (m) => {
            try {
              const msg = m.messages?.[0];
              if (!msg) return;
              const from = msg.key.remoteJid;
              if (from !== sock.user.id) return; // self check

              const text = (msg.message?.conversation || '').trim().toUpperCase();
              if (text === `APPROVE ${approvalCode}`) {
                resolve(true);
                sock.ev.off('messages.upsert', handler);
              }
            } catch { }
          };
          sock.ev.on('messages.upsert', handler);

          setTimeout(() => {
            sock.ev.off('messages.upsert', handler);
            resolve(false);
          }, 5 * 60 * 1000);
        });

        if (approved) {
          approveUser(ownerNumber);
          console.log(chalk.green('Approved! Starting messaging.'));
          await flowSendMessages(sock);
        } else {
          console.log(chalk.red('Approval timeout or denied, exiting.'));
          process.exit(1);
        }

      } else {
        console.log(chalk.green('Already approved, starting messaging.'));
        await flowSendMessages(sock);
      }
    }
  });

  async function flowSendMessages(sock) {
    let useGroup = loadGroupChoice();
    if (!useGroup) {
      useGroup = (await ask('Send messages to group? (yes/no)')).toLowerCase();
      saveGroupChoice(useGroup);
    } else {
      console.log(`Using stored group choice: ${useGroup}`);
    }

    let targetJid = null;
    if (useGroup === 'yes') {
      const groups = await sock.groupFetchAllParticipating();
      const groupArr = Object.values(groups);
      if (groupArr.length === 0) {
        console.log(chalk.yellow('No groups found, exiting.'));
        process.exit(0);
      }
      console.log(chalk.blue('Available groups:'));
      groupArr.forEach((g, i) => {
        console.log(`${i + 1}. ${g.subject} (${g.id})`);
      });
      let choice = await ask('Choose group number or enter full Group JID: ');
      const idx = parseInt(choice, 10);
      if (!isNaN(idx) && idx > 0 && idx <= groupArr.length) {
        targetJid = groupArr[idx - 1].id;
      } else {
        targetJid = choice.trim();
      }
    } else {
      const number = await ask('Enter target phone number (with country code, e.g. 911234567890): ');
      targetJid = `${number.replace(/[^\d]/g, '')}@s.whatsapp.net`;
    }

    const prefix = await ask('Enter prefix for messages (leave empty for none): ');
    const messageFile = await ask('Enter path of message file (.txt): ');

    if (!fs.existsSync(messageFile)) {
      console.log(chalk.red('Message file not found, exiting.'));
      process.exit(1);
    }

    const rawMessages = fs.readFileSync(messageFile, 'utf-8').split('\n').map(m => m.trim()).filter(Boolean);

    const intervalSec = parseInt(await ask('Enter interval between messages (seconds): '), 10) || 10;

    console.log(chalk.white(`\nStarting to send messages to ${targetJid} every ${intervalSec} seconds...\n`));

    let index = 0;
    while (true) {
      const msgText = prefix ? `${prefix} ${rawMessages[index]}` : rawMessages[index];
      try {
        await sock.sendMessage(targetJid, { text: msgText });
        console.log(chalk.green(`[${index + 1}] Sent: ${msgText}`));
      } catch (e) {
        console.log(chalk.red(`[${index + 1}] Failed to send: ${e.message}`));
      }
      index = (index + 1) % rawMessages.length;
      await new Promise(r => setTimeout(r, intervalSec * 1000));
    }
  }
}

start().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
