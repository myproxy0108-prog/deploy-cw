// --- エラー対策：古いNode.jsでも動くようにする設定 ---
const fetch = require('node-fetch');
if (!globalThis.fetch) {
    globalThis.fetch = fetch;
    globalThis.Headers = fetch.Headers;
    globalThis.Request = fetch.Request;
    globalThis.Response = fetch.Response;
}

const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// --- 環境変数 ---
const {
    CW_TOKEN,
    SUPABASE_URL,
    SUPABASE_KEY,
    RENDER_KEYS // カンマ区切り
} = process.env;

// リポジトリ設定
const REPO_CONFIG = {
    "tube": "https://github.com/mino-hobby-pro/MIN-Tube-Pro",
    "mirror": "https://github.com/myproxy0108-prog/Cloud-moon-mirror"
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

let ACCOUNTS = [];

// --- 起動時にAPIキーからOwnerIDを自動取得 ---
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
            console.log(`✅ アカウント読み込み完了: ${ownerId}`);
        } catch (e) {
            console.error(`❌ 無効なAPIキーです: ${key.substring(0, 10)}...`);
        }
    }
    ACCOUNTS = loaded;
}

// --- 3日経過したものを削除するお掃除機能 ---
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
                console.log(`🗑️ 期限切れ削除: ${item.service_type}`);
            } catch (e) {
                await supabase.from('deploy_logs').delete().eq('id', item.id);
            }
        }
    }
}
setInterval(cleanup, 1000 * 60 * 60); // 1時間に1回実行

// --- Webhookメイン処理 ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body || !event.body.startsWith('/deploy')) return;

    const { account_id, body, room_id } = event;
    const user_name = event.from_account_id_name || "ユーザー";
    const repoKey = body.split(' ')[1];
    const repoUrl = REPO_CONFIG[repoKey];

    if (!repoUrl) {
        const list = Object.keys(REPO_CONFIG).join(', ');
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[info][title]⚠️ 種類エラー[/title]${list} から選んでください。[/info]`);
        return;
    }

    if (ACCOUNTS.length === 0) return;

    // 1日1回制限
    const today = new Date().toISOString().split('T')[0];
    const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
    if (logs && logs.length > 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](stop) 1日1回制限[/title]${user_name}さん、また明日作りにきてね！[/info]`);
        return;
    }

    // 受付メッセージ
    const startRes = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](dance) 了解です！[/title]「${repoKey}」を構築します。(コーヒー)[hr]完了まで数分お待ちください。[/info]`);
    const cw_msg_id = startRes.data.message_id;

    try {
        // アカウントをランダムに選ぶ
        const acc = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];

        // Renderで新規サービス作成
        const serviceName = `tmp-${repoKey}-${Date.now()}`.substring(0, 30);
        const createRes = await axios.post('https://api.render.com/v1/services', {
            name: serviceName,
            ownerId: acc.ownerId,
            type: 'web_service',
            repo: repoUrl,
            autoDeploy: 'no',
            serviceDetails: { 
                env: 'node', 
                region: 'oregon', 
                plan: 'free'
            }
        }, { headers: { Authorization: `Bearer ${acc.key}` } });

        const serviceId = createRes.data.id;
        const deployUrl = createRes.data.url;
        
        // 3日後の削除日時
        const deleteAt = new Date();
        deleteAt.setDate(deleteAt.getDate() + 3);

        // Supabaseに保存
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

        // 45秒後にURLを編集して表示
        setTimeout(async () => {
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                `body=[rp aid=${account_id} to=${room_id}]\n[info][title](cracker) ${repoKey.toUpperCase()} 完了！ (cracker)[/title]あなた専用URLができました！(shiny)\n\n🌐 URL:\n${deployUrl}\n\n[hr]⚠️ 3日後にこのURLとメッセージは自動削除されます。[/info]`);
        }, 45000);

    } catch (err) {
        console.error(err.response?.data || err.message);
        await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=[info][title](shock) エラー[/title]作成に失敗しました。[/info]`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`ボット起動中... Port: ${PORT}`);
    await initAccounts();
});
