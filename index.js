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
    RENDER_KEYS // カンマ区切り例: rnd_key1,rnd_key2
} = process.env;

// リポジトリ設定（GitHubのURL）
const REPO_CONFIG = {
    "tube": "https://github.com/mino-hobby-pro/MIN-Tube-Pro",
    "mirror": "https://github.com/myproxy0108-prog/Cloud-moon-mirror"
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Chatwork API設定
const cwApi = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': CW_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});

// アカウント情報を保持する配列
let ACCOUNTS = [];

// --- 1. 起動時：全てのAPIキーからOwnerIDを自動取得 ---
async function initAccounts() {
    const keys = RENDER_KEYS ? RENDER_KEYS.split(',') : [];
    const loaded = [];
    for (const k of keys) {
        const key = k.trim();
        try {
            const res = await axios.get('https://api.render.com/v1/owners', {
                headers: { Authorization: `Bearer ${key}` }
            });
            // res.data[0].owner.id を取得
            const ownerId = res.data[0].owner.id;
            loaded.push({ key, ownerId });
            console.log(`✅ Account Loaded: ${ownerId}`);
        } catch (e) {
            console.error(`❌ Invalid Render Key: ${key.substring(0, 8)}...`);
        }
    }
    ACCOUNTS = loaded;
    if (ACCOUNTS.length === 0) console.error("⚠️ 有効なRenderアカウントが1つもありません！");
}

// --- 2. お掃除：3日経過したサービスを削除 ---
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
                console.log(`🗑️ Deleted service: ${item.render_service_id}`);
            } catch (e) {
                console.error("Cleanup error:", e.message);
                // すでに消えている場合はDBから削除
                await supabase.from('deploy_logs').delete().eq('id', item.id);
            }
        }
    }
}
setInterval(cleanup, 1000 * 60 * 60); // 1時間に1回

// --- 3. メイン：デプロイ処理 ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const event = req.body.webhook_event;
    if (!event || !event.body || !event.body.startsWith('/deploy')) return;

    const { account_id, body, room_id } = event;
    const user_name = event.from_account_id_name || "ユーザー";
    const repoKey = body.split(' ')[1];
    const repoUrl = REPO_CONFIG[repoKey];

    if (!repoUrl) {
        const available = Object.keys(REPO_CONFIG).join(', ');
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[info][title]⚠️ エラー[/title]「${repoKey}」は未登録です。\n使用可能: ${available}[/info]`);
        return;
    }

    if (ACCOUNTS.length === 0) return;

    // 1日1回制限
    const today = new Date().toISOString().split('T')[0];
    const { data: logs } = await supabase.from('deploy_logs').select('*').eq('user_id', account_id.toString()).eq('deployed_at', today);
    if (logs && logs.length > 0) {
        await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](stop) 1日1回まで[/title]本日はすでに実行済みです。また明日お試しください！[/info]`);
        return;
    }

    // 受付通知
    const startRes = await cwApi.post(`/rooms/${room_id}/messages`, `body=[rp aid=${account_id} to=${room_id}]\n[info][title](dance) 了解！${repoKey} を作ります[/title]Renderのアカウントを分散して構築を開始しました。(コーヒー)[hr]完了まで数分お待ちください。[/info]`);
    const cw_msg_id = startRes.data.message_id;

    try {
        // アカウントをランダム選択
        const acc = ACCOUNTS[Math.floor(Math.random() * ACCOUNTS.length)];

        // 新規サービス作成
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
                plan: 'free',
                buildCommand: 'npm install', // 必要に応じて変更
                startCommand: 'npm start'     // 必要に応じて変更
            }
        }, { headers: { Authorization: `Bearer ${acc.key}` } });

        const serviceId = createRes.data.id;
        const deployUrl = createRes.data.url;
        const deleteAt = new Date();
        deleteAt.setDate(deleteAt.getDate() + 3); // 3日後

        // DB保存
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

        // 完了編集
        setTimeout(async () => {
            await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, 
                `body=[rp aid=${account_id} to=${room_id}]\n[info][title](cracker) ${repoKey.toUpperCase()} 完了！ (cracker)[/title]あなた専用のURLを発行しました！(shiny)\n\n🌐 URL:\n${deployUrl}\n\n[hr]⚠️ 3日後にこのURLとメッセージは自動削除されます。[/info]`);
        }, 45000); // 45秒待ってURLを表示

    } catch (err) {
        console.error(err.response?.data || err.message);
        await cwApi.put(`/rooms/${room_id}/messages/${cw_msg_id}`, `body=[info][title](shock) エラー[/title]作成に失敗しました。APIキーの制限か、リポジトリの連携設定を確認してください。[/info]`);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await initAccounts();
});
