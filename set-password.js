#!/usr/bin/env node
// set-password.js — 设置管理密码（SHA256 哈希存储）
// 用法: node set-password.js <类型> <密码>
// 类型: player | lyrics | slots
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '.auth');

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { mode: 0o700 });
}

const type = process.argv[2];
const password = process.argv[3];

const VALID_TYPES = {
    player: 'Player 模式切换密码',
    lyrics: '歌词编辑密码',
    slots: 'Voice Slots 重置密码',
    sleep: '睡眠锁密码'
};

if (!type || !password || !VALID_TYPES[type]) {
    console.log('用法: node set-password.js <类型> <密码>');
    console.log('类型:');
    Object.entries(VALID_TYPES).forEach(([k, v]) => {
        console.log(`  ${k} — ${v}`);
    });
    console.log('\n示例: node set-password.js player MySecurePass123');
    process.exit(1);
}

const hash = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
const authFile = path.join(AUTH_DIR, `${type}.hash`);
fs.writeFileSync(authFile, hash, { mode: 0o600 });

console.log(`✅ ${VALID_TYPES[type]} 已设置！`);
console.log(`   哈希已保存到 .auth/${type}.hash`);
console.log('⚠️  请记住密码，哈希不可逆。如忘记请重新运行此脚本。');
