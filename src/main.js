const a = require('@whiskeysockets/baileys');
const b = require('pino');
const c = require('qrcode-terminal');
const d = require('fs');
const e = require('readline');
const f = require('chalk');

const {
  makeWASocket: g,
  useMultiFileAuthState: h,
  DisconnectReason: i,
  makeCacheableSignalKeyStore: j,
} = a;

const k = './l.json', m = './n.json', o = './p';

function q() {
  if(d.existsSync(k)) {
    return JSON.parse(d.readFileSync(k,'utf-8'));
  }
  return {};
}

function r(s) {
  d.writeFileSync(k,JSON.stringify(s,null,2));
}

function t(u) {
  const v = q();
  v[u] = !0;
  r(v);
  console.log(`Approved: ${u}`);
}

function w(x) {
  const y = q();
  if(y[x]) {
    delete y[x];
    r(y);
    console.log(`Removed approval for: ${x}`);
  } else {
    console.log(`No approval found for: ${x}`);
  }
}

function z(A) {
  const B = q();
  return !!B[A];
}

function C() {
  if(d.existsSync(m)) {
    return JSON.parse(d.readFileSync(m,'utf-8'));
  }
  return null;
}

function D(E) {
  d.writeFileSync(m,JSON.stringify(E));
}

async function F(G) {
  return new Promise(H=>{
    const I = e.createInterface({ input: process.stdin, output: process.stdout });
    I.question(f.cyan(G + ' (bot): '),J=>{I.close();H(J.trim());});
  });
}

async function K() {
  console.log(f.green('Bot Started'));

  const { state, saveCreds: L, cache: M } = await h(o);

  const N = g({
    logger: b({ level: 'silent' }),
    auth: { creds: state.creds, keys: j(state.keys,b({level: 'fatal'}),M) },
    printQRInTerminal: !0
  });

  N.ev.on('creds.update', L);

  N.ev.on('connection.update', async (O) => {
    if (O.qr) {
      console.log(f.yellow('Scan QR:'));
      c.generate(O.qr, { small: !0 });
    }
    if (O.connection === 'close') {
      let P = O.lastDisconnect?.error?.output?.statusCode;
      console.log(f.red(`Conn closed: ${P}`));
      if(P !== i.loggedOut) {
        console.log(f.yellow('Reconnect in 3s'));
        await new Promise(Q=>setTimeout(Q,3000));
        K();
      } else {
        console.log(f.red('Logged out, exit'));
        process.exit(0);
      }
    }
    if (O.connection === 'open') {
      console.log(f.green('Connected!'));
      let R = N.user.id.split('@')[0];
      if (!z(R)) {
        console.log(f.yellow('Awaiting approval...'));
        let S = Math.random().toString(36).substr(2,6).toUpperCase();
        await N.sendMessage(N.user.id, { text: `Approve code: ${S}` });
        let T = await new Promise(U=>{
          let V = async(Y) => {
            try {
              let Z = Y.messages?.[0];
              if(!Z) return;
              if(Z.key.remoteJid !== N.user.id) return;
              let aa = (Z.message?.conversation || '').trim().toUpperCase();
              if(aa === `APPROVE ${S}`) {
                U(true);
                N.ev.off('messages.upsert', V);
              }
            } catch {}
          };
          N.ev.on('messages.upsert', V);
          setTimeout(() => {
            N.ev.off('messages.upsert', V);
            U(false);
          }, 5*60*1000);
        });
        if(T) {
          t(R);
          console.log(f.green('Approved, starting sending'));
          await ab(N);
        } else {
          console.log(f.red('Approval timeout/denied, exit'));
          process.exit(1);
        }
      } else {
        console.log(f.green('Already approved, sending...'));
        await ab(N);
      }
    }
  });

  async function ab(ac) {
    let ad = C();
    if(!ad) {
      ad = (await F('Send to group? (yes/no)')).toLowerCase();
      D(ad)
    } else {
      console.log(`Group choice: ${ad}`);
    }
    let ae;
    if(ad === 'yes') {
      let af = await ac.groupFetchAllParticipating();
      let ag = Object.values(af);
      if(!ag.length) {
        console.log(f.yellow('No groups found, exit'));
        process.exit(0);
      }
      console.log(f.blue('Groups:'));
      ag.forEach((ah,ai) => {
        console.log(`${ai+1}. ${ah.subject} (${ah.id})`);
      });
      let aj = await F('Choose group number or full JID');
      let ak = parseInt(aj,10);
      ae = (!isNaN(ak) && ak > 0 && ak <= ag.length) ? ag[ak-1].id : aj.trim();
    } else {
      let al = await F('Target number (e.g. 911234567890)');
      ae = `${al.replace(/[^\d]/g, '')}@s.whatsapp.net`;
    }

    let am = await F('Prefix for messages (leave empty none)');
    let an = await F('Message file path (.txt)');

    if(!d.existsSync(an)) {
      console.log(f.red('File not found, exit'));
      process.exit(1);
    }

    let ao = d.readFileSync(an,'utf-8').split('\n').map(ap => ap.trim()).filter(Boolean);
    let aq = parseInt(await F('Interval (sec)'),10) || 10;
    console.log(f.white(`Sending to ${ae} every ${aq} secs\n`));
    let ar = 0;
    while(true) {
      let as = am ? `${am} ${ao[ar]}` : ao[ar];
      try {
        await ac.sendMessage(ae, { text: as });
        console.log(f.green(`[${ar+1}] Sent: ${as}`));
      } catch(at) {
        console.log(f.red(`[${ar+1}] Error: ${at.message}`));
      }
      ar = (ar + 1) % ao.length;
      await new Promise(au => setTimeout(au, aq*1000));
    }
  }
}

K().catch(av => {
  console.error('Fatal:', av);
  process.exit(1);
});
