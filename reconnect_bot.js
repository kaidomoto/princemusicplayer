const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');

const accts = JSON.parse(fs.readFileSync('/root/prince-music/data/accounts.json'));
const acct = accts.accounts['main'];
const channel = 'PDv2BnWr';

const hdrs = {
  'Content-Type': 'application/json; charset=utf-8',
  'CH-AppBuild': acct.appBuild || '3375',
  'CH-AppVersion': acct.appVersion || '24.01.02',
  'User-Agent': acct.userAgent,
  'CH-DeviceId': acct.deviceId,
  'Authorization': 'Token ' + acct.token,
  'CH-UserID': String(acct.userId),
  'Accept': 'application/json',
  'Accept-Language': 'en-US;q=1',
};

function chPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'www.clubhouseapi.com',
      path: '/api/' + endpoint,
      method: 'POST',
      headers: { ...hdrs, 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  try {
    console.log('1. join_channel...');
    const jd = await chPost('join_channel', {
      channel,
      attribution_source: 'feed',
      attribution_details: 'eyJpc19leHBsb3JlIjpmYWxzZSwiY2hhbm5lbF90b3BpYyI6bnVsbH0='
    });
    let agoraToken = jd.token || '';
    const appId = (jd.agora_info || {}).app_id || '938de3e8055e42b281bb8c6f69c21f78';
    console.log('   success=' + jd.success + ', token=' + (agoraToken ? 'yes' : 'NO'));

    console.log('2. become_speaker...');
    const bs = await chPost('become_speaker', { channel });
    if (bs.token) { agoraToken = bs.token; }
    console.log('   success=' + bs.success + ', token=' + (agoraToken ? 'yes' : 'NO'));

    console.log('3. API unmute...');
    const um = await chPost('update_channel_user_status', { channel, is_muted: false });
    console.log('   success=' + um.success);

    if (!agoraToken) { console.error('NO AGORA TOKEN - cannot connect bridge'); process.exit(1); }

    console.log('4. Bridge join+unmute on port 8767...');
    const ws = new WebSocket('ws://127.0.0.1:8767');
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'leave' }));
      setTimeout(() => {
        ws.send(JSON.stringify({ id: 1, action: 'join', token: agoraToken, channel_name: channel, user_id: acct.userId, speaker: true, app_id: appId }));
        console.log('   Agora join sent');
      }, 300);
      setTimeout(() => {
        ws.send(JSON.stringify({ action: 'unmute' }));
        console.log('   unmute sent');
        ws.close();
        console.log('DONE - Bot should be speaking now!');
        process.exit(0);
      }, 5000);
    });
    ws.on('error', e => { console.error('Bridge WS error:', e.message); process.exit(1); });
  } catch(e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
