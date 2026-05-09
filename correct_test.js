#!/usr/bin/env node
// CORRECT bridge format test + different UIDs
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const { spawn } = require('child_process');
const CH_API = 'https://www.clubhouseapi.com/api';
const CH = {
    'Content-Type': 'application/json; charset=utf-8',
    'CH-AppBuild': '5200', 'CH-AppVersion': '26.03.01',
    'User-Agent': 'clubhouse/5200 (iPhone; iOS 18.3; Scale/3.00)',
    'CH-DeviceId': '5213047C-4122-4532-8F78-CDE64F39D215',
    'Authorization': 'Token edb1eff54a008ceea9ef8900b28fc55d76c8f896',
    'CH-UserID': '450417781',
};
const AGORA_APP_ID = '938de3e8055e42b281bb8c6f69c21f78';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ch(ep, d) { return (await axios.post(`${CH_API}/${ep}`, d, {headers:CH})).data; }

function bridgeJoin(port, token, channelName, userId) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('open', () => {
            console.log(`   Bridge ${port}: WS open, sending join...`);
            ws.send(JSON.stringify({
                id: 1,
                action: 'join',
                token: token,
                channel_name: channelName,
                user_id: userId,
                speaker: true,
                app_id: AGORA_APP_ID,
            }));
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                console.log(`   Bridge ${port}: ${JSON.stringify(msg).substring(0, 100)}`);
                if (msg.ok !== undefined) {
                    if (Number(msg.ok) === 0) {
                        console.log(`   Bridge ${port}: ✅ Agora joined! Sending unmute...`);
                        ws.send(JSON.stringify({ action: 'unmute' }));
                        resolve(ws);
                    } else {
                        console.log(`   Bridge ${port}: ❌ Join failed: ok=${msg.ok}`);
                        reject(new Error(`Join failed: ok=${msg.ok}`));
                    }
                }
            } catch (e) {
                console.log(`   Bridge ${port}: raw msg: ${data.toString().substring(0,80)}`);
            }
        });
        ws.on('error', (e) => { console.log(`   Bridge ${port}: error: ${e.message}`); reject(e); });
        setTimeout(() => resolve(ws), 10000); // fallback
    });
}

async function main() {
    const sm = require('./session-manager');
    const rooms = []; const sids = [];
    try {
        console.log('1. Session A + Room A...');
        const sA = await sm.createSession();
        sids.push(sA.sessionId);
        const rA = await ch('create_channel', {topic:'🎵 Multi-A', privacy_level:'public', is_social_mode:false, is_replay_enabled:false});
        rooms.push(rA.channel);
        await ch('update_channel_user_status', {channel: rA.channel, is_muted: false});
        try { await ch('disable_replay', {channel:rA.channel, channel_id:rA.channel_id}); } catch(e){}
        try { await ch('hide_channel_from_replay_profile', {channel:rA.channel, channel_id:rA.channel_id}); } catch(e){}
        
        await sleep(4000);
        console.log('   Joining Agora A (CORRECT format)...');
        const wsA = await bridgeJoin(sA.bridgePort, rA.token, rA.channel, 450417781);
        
        // Play audio on A
        const sidA = sA.sessionId.substring(0,8);
        spawn('sudo', ['-u','studio','bash','-c',
            `PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native PULSE_SINK=session_${sidA} ffplay -nodisp -autoexit -t 600 "$(ls /root/prince-music/storage/*.mp3 | head -1)"`
        ], {stdio:'ignore',detached:true}).unref();
        
        await sleep(2000);
        
        console.log('\n2. Session B + Room B...');
        const sB = await sm.createSession();
        sids.push(sB.sessionId);
        const rB = await ch('create_channel', {topic:'🎵 Multi-B', privacy_level:'public', is_social_mode:false, is_replay_enabled:false});
        rooms.push(rB.channel);
        await ch('update_channel_user_status', {channel: rB.channel, is_muted: false});
        try { await ch('disable_replay', {channel:rB.channel, channel_id:rB.channel_id}); } catch(e){}
        try { await ch('hide_channel_from_replay_profile', {channel:rB.channel, channel_id:rB.channel_id}); } catch(e){}
        
        await sleep(4000);
        console.log('   Joining Agora B (uid=450417782)...');
        const wsB = await bridgeJoin(sB.bridgePort, rB.token, rB.channel, 450417782);
        
        const sidB = sB.sessionId.substring(0,8);
        spawn('sudo', ['-u','studio','bash','-c',
            `PULSE_SERVER=unix:/tmp/runtime-studio/pulse/native PULSE_SINK=session_${sidB} ffplay -nodisp -autoexit -t 600 "$(ls /root/prince-music/storage/*.mp3 | tail -1)"`
        ], {stdio:'ignore',detached:true}).unref();

        const urlA = rA.url || `https://www.clubhouse.com/room/${rA.channel}`;
        const urlB = rB.url || `https://www.clubhouse.com/room/${rB.channel}`;
        fs.writeFileSync('/tmp/test_rooms.json', JSON.stringify({urlA, urlB}, null, 2));
        console.log(`\nROOMS_READY`);
        console.log(`Room A: ${urlA}`);
        console.log(`Room B: ${urlB}`);
        
        // Wait 5 min
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
