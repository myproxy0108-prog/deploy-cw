// 【究極対策】Headersが見つからないエラーを物理的に消す
if (typeof globalThis.Headers === 'undefined') {
    const { Headers, Request, Response, fetch } = require('undici');
    globalThis.Headers = Headers;
    globalThis.Request = Request;
    globalThis.Response = Response;
    globalThis.fetch = fetch;
}

const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const { CW_TOKEN, SUPABASE_URL, SUPABASE_KEY, RENDER_KEYS } = process.env;

const REPO_CONFIG = {
    "tube": "https://github.com/mino-hobby-pro/MIN-Tube-Pro",
    "mirror": "https://github.com/myproxy0108-prog/Cloud-moon-mirror"
};

// Supabaseクライアント作成
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

let ACCOUNTS = [];

async function initAccounts() {
    const keys = RENDER_KEYS ? RENDER_KEYS.split(',') : [];
    const loaded = [];
    for (const k of keys) {
        const key = k.trim();
        if (!key) continue;
        try {
            const res = await axios.get('https://api.render.com/v1/owners', {
                headers: { Authorization: `Bearer ${key}` }
            });
            const ownerId = res.data[0].owner.id;
            loaded.push({ key, ownerId });
            console.log(`✅ Account Loaded: ${ownerId}`);
        } catch (e) {
            console.error(`❌ Key Invalid: ${key.substring(0, 10)}...`);
        }
    }
    ACCOUNTS = loaded;
}

async function cleanup() {
    const now = new Date().toISOString();
    const { data: targets } = await supabase.from('deploy_logs').select('*').lt('delete_at', now);
    if (targets && targets.length > 0) {
        for (const item of targets) {
            try {
                const acc = ACCOUNTS.find(a => a.ownerId === item.render_owner_id);
                if (acc) {
                    await axios.delete(`https://api.render.com/v1/services/${item.render_service_id}`, {
                        headers: { Authorization: `Bearer ${acc.key}` }
                    });
                }
                await cwApi.delete(`/rooms/${item.cw_room_id}/messages/${item.cw_message_id}`);
                await supabase.from('deploy_logs').delete().eq('id', item.id);
            } catch (e) {
                await supabase.from('deploy_logs').delete().eq('id', item.id);
            }
        }
    }
}
setInterval(cleanup, 1000 * 60 * 60);

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body || !event.body.startsWith('/deploy')) return;

    const { account_id, body, room_id } = event;
    const user_name = event.from_account_id_name || "ユーザー";
    const repoKey = body.split(' ')[1];
    const repoUrl = REPO_CONFIG[repoKey];

    if (!repoUrl || ACCOUNTS.length === 0) return;

    const today = new Date().toISOString().split('T')[0];
    const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
    
    if (logs && logs.length > 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](stop) 制限[/title]1日1回までです。[/info]`);
        return;
    }

    const startRes = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](dance) 準備中[/title]構築を開始しました。[/info]`);
    const cw_msg_id = startRes.data.message_id;

    try {
        const acc = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];
        const serviceName = `tmp-${repoKey}-${Date.now()}`.substring(0, 30);
        const createRes = await axios.post('https://api.render.com/v1/services', {
            name: serviceName,
            ownerId: acc.ownerId,
            type: 'web_service',
            repo: repoUrl,
            autoDeploy: 'no',
            serviceDetails: { env: 'node', region: 'oregon', plan: 'free' }
        }, { headers: { Authorization: `Bearer ${acc.key}` } });

        const serviceId = createRes.data.id;
        const deployUrl = createRes.data.url;
        const deleteAt = new Date();
        deleteAt.setDate(deleteAt.getDate() + 3);

        await supabase.from('deploy_logs').insert([{
            user_id: account_id.toString(),
            user_name,
            service_type: repoKey,
            render_service_id: serviceId,
            render_owner_id: acc.ownerId,
            cw_message_id: cw_msg_id,
            cw_room_id: room_id.toString(),
            delete_at: deleteAt.toISOString()
        }]);

        setTimeout(async () => {
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                `body=[rp aid=${account_id} to=${room_id}]\n[info][title](cracker) 完了[/title]URL: ${deployUrl}\n※3日後に削除されます。[/info]`);
        }, 45000);

    } catch (err) {
        await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=エラーが発生しました。`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Bot Active on Port ${PORT}`);
    await initAccounts();
});
