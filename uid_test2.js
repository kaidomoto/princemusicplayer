#!/usr/bin/env node
// UID test v2 — writes room URLs to a file so we can share them
const WebSocket = require('ws');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const CH_API = 'https://www.clubhouseapi.com/api';
const CH = {
    'Content-Type': 'application/json; charset=utf-8',
    'CH-AppBuild': '5200', 'CH-AppVersion': '26.03.01',
    'User-Agent': 'clubhouse/5200 (iPhone; iOS 18.3; Scale/3.00)',
    'CH-DeviceId': '5213047C-4122-4532-8F78-CDE64F39D215',
    'Authorization': 'Token edb1eff54a008ceea9ef8900b28fc55d76c8f896',
    'CH-UserID': '450417781',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ch(ep, d) { return (await axios.post(`${CH_API}/${ep}`, d, {headers:CH})).data; }

async function main() {
    const sm = require('./session-manager');
    const rooms = []; const sids = [];
    try {
        const sA = await sm.createSession();
        sids.push(sA.sessionId);
        const rA = await ch('create_channel', {topic:'UID Test A', privacy_level:'public', is_social_mode:false});
        rooms.push(rA.channel);
        await ch('update_channel_user_status', {channel: rA.channel, is_muted: false});
        await sleep(3000);
        const wsA = new WebSocket(`ws://127.0.0.1:${sA.bridgePort}`);
        await new Promise(r => wsA.on('open', r));
        wsA.send(JSON.stringify({type:'join', channel:rA.channel, token:rA.token, uid: 450417781}));
        wsA.send(JSON.stringify({action:'unmute'}));
        const sidA = sA.sessionId.substring(0,8);
        spawn('sudo', ['-u','studio','bash','-c',
            `PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native PULSE_SINK=session_${sidA} ffplay -nodisp -autoexit -t 600 "$(ls /root/prince-music/storage/*.mp3 | head -1)"`
        ], {stdio:'ignore',detached:true}).unref();

        const sB = await sm.createSession();
        sids.push(sB.sessionId);
        const rB = await ch('create_channel', {topic:'UID Test B', privacy_level:'public', is_social_mode:false});
        rooms.push(rB.channel);
        await ch('update_channel_user_status', {channel: rB.channel, is_muted: false});
        await sleep(3000);
        const wsB = new WebSocket(`ws://127.0.0.1:${sB.bridgePort}`);
        await new Promise(r => wsB.on('open', r));
        wsB.send(JSON.stringify({type:'join', channel:rB.channel, token:rB.token, uid: 450417782}));
        wsB.send(JSON.stringify({action:'unmute'}));
        const sidB = sB.sessionId.substring(0,8);
        spawn('sudo', ['-u','studio','bash','-c',
            `PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native PULSE_SINK=session_${sidB} ffplay -nodisp -autoexit -t 600 "$(ls /root/prince-music/storage/*.mp3 | tail -1)"`
        ], {stdio:'ignore',detached:true}).unref();

        // Write URLs to file
        const urlA = rA.url || `https://www.clubhouse.com/room/${rA.channel}`;
        const urlB = rB.url || `https://www.clubhouse.com/room/${rB.channel}`;
        fs.writeFileSync('/tmp/test_rooms.json', JSON.stringify({
            roomA: { channel: rA.channel, url: urlA, uid: 450417781 },
            roomB: { channel: rB.channel, url: urlB, uid: 450417782 },
        }, null, 2));
        console.log('ROOMS_READY');
        console.log(`Room A: ${urlA}`);
        console.log(`Room B: ${urlB}`);

        // Wait 5 minutes for user to test
        await sleep(300000);
    } catch(e) { console.error('Error:', e.response?.data || e.message); }
    finally {
        for (const c of rooms) { try { await ch('end_channel',{channel:c}); } catch(e) {} }
        for (const id of sids) { try { await sm.deleteSession(id); } catch(e) {} }
        try { require('child_process').execSync('pkill -f "ffplay.*autoexit" 2>/dev/null||true'); } catch(e) {}
        process.exit(0);
    }
}
main();
